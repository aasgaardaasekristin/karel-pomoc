/**
 * dailyLifecycleResolver.ts — Slice 3B (Daily Lifecycle + Decision Deck Cleanup)
 *
 * PURE FUNCTIONS. Žádné DB volání, žádné side-effecty.
 * Vstupem jsou už načtené řádky z existujících tabulek + briefing payload.
 * Výstupem je sjednocený DailyLifecycleItem[] podle src/types/dailyLifecycle.ts.
 *
 * Lifecycle mapping (Slice 2 spec sekce B, locked):
 *
 *   tasks (did_therapist_tasks):
 *     - status='pending' & created today (Prague) & escalation_level<=0  → new_today
 *     - status='pending' & not created today                              → waiting_response
 *     - status='pending' & escalation_level >= 1                          → escalate_to_meeting
 *     - status='pending' & due_date < today (overdue)                     → needs_reissue
 *     - status='archived' & completed_at != null                          → done
 *     - status='archived' & completed_at == null                          → dropped
 *     - status='expired'                                                  → not_relevant_anymore
 *
 *   pending_questions (did_pending_questions):
 *     - status='open' & created today                                     → new_today
 *     - status='open' & created earlier & blocking != null                → waiting_response (blocking=true)
 *     - status='open' & created earlier & blocking == null                → waiting_response (blocking=false)
 *     - status='open' & expires_at < now                                  → needs_reissue
 *     - status='answered'                                                 → done
 *     - status='archived'                                                 → dropped
 *     - status='expired'                                                  → not_relevant_anymore
 *
 *   briefing waiting items (briefing.payload.waiting_for[]):
 *     - vždy waiting_response, blocking=true (briefing je už filtr) — ale
 *       jsou bez stable id, takže resolver je deduplikuje s pending_questions
 *       podle text-prefix matche (poslední 80 znaků).
 *
 *   crisis deficits (z `crisis_events` rows + computed deficity):
 *     - chybí dnešní morning_review                                       → new_today (audience='karel', blocking)
 *     - chybí dnešní evening_decision                                     → new_today (audience='karel', blocking)
 *     - awaiting_response_from obsahuje 'hanka'/'kata'                    → waiting_response (blocking)
 *     - closed_at != null                                                 → not_relevant_anymore
 *
 *   session proposals (briefing.payload.proposed_session):
 *     - existuje proposal & ještě není scheduled                          → new_today (audience='karel')
 *     - linked do did_daily_session_plans                                 → scheduled_for_session
 *
 * Pokud zdroj nemá dost dat pro jednoznačnou klasifikaci, volíme
 * NEJBEZPEČNĚJŠÍ stav (typicky waiting_response místo done — aby se
 * nikdy neztratila otevřená položka z decision decku).
 */

import {
  DailyLifecycleAudience,
  DailyLifecycleBuckets,
  DailyLifecycleItem,
  DailyLifecycleStatus,
  EMPTY_BUCKETS,
} from "@/types/dailyLifecycle";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";

// ─── Vstupní řádky (jen sloupce, které resolver opravdu používá) ───────────

export interface RawTaskRow {
  id: string;
  task: string;
  status: string;            // pending | archived | expired
  assigned_to: string | null;
  status_hanka?: string | null;
  status_kata?: string | null;
  escalation_level?: string | number | null;
  due_date?: string | null;
  created_at: string;
  completed_at?: string | null;
  task_tier?: string | null;
}

export interface RawPendingQuestionRow {
  id: string;
  question: string;
  status: string | null;     // open | answered | expired | archived
  blocking?: string | null;
  directed_to: string | null;
  created_at: string;
  expires_at?: string | null;
  answer?: string | null;
  answered_at?: string | null;
  crisis_event_id?: string | null;
  subject_type?: string | null;
}

export interface RawBriefingWaitingItem {
  /** Briefing waiting items jsou jen text. */
  text: string;
  /** Briefing day (ISO). */
  briefing_date: string;
}

export interface RawCrisisEventRow {
  id: string;
  part_name: string;
  closed_at?: string | null;
  last_morning_review_at?: string | null;
  last_evening_decision_at?: string | null;
  awaiting_response_from?: string[] | null;
  primary_therapist?: string | null;
  severity?: string | null;
}

export interface RawSessionProposal {
  /** Stabilní id (linked_briefing_item_id). */
  id?: string | null;
  part_name: string;
  why_today: string;
  briefing_date: string;
  /** True pokud už existuje řádek v did_daily_session_plans pro dnešek. */
  isScheduled?: boolean;
}

export interface ResolverInput {
  now?: Date;
  tasks?: RawTaskRow[];
  questions?: RawPendingQuestionRow[];
  briefingWaitingFor?: RawBriefingWaitingItem[];
  crisisEvents?: RawCrisisEventRow[];
  sessionProposals?: RawSessionProposal[];
}

// ─── Helpery ───────────────────────────────────────────────────────────────

const isToday = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return false;
  return iso.slice(0, 10) === pragueTodayISO(now);
};

const isOverdue = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return false;
  return iso.slice(0, 10) < pragueTodayISO(now);
};

const isExpired = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return false;
  return new Date(iso).getTime() < now.getTime();
};

const escalationNumber = (raw: unknown): number => {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const directedToAudience = (raw: string | null | undefined): DailyLifecycleAudience => {
  if (raw === "hanka") return "hanka";
  if (raw === "kata") return "kata";
  if (raw === "both") return "both";
  return "unknown";
};

const assignedToAudience = (raw: string | null | undefined): DailyLifecycleAudience => {
  if (raw === "hanka") return "hanka";
  if (raw === "kata") return "kata";
  if (raw === "both") return "both";
  return "unknown";
};

/** Krátký jednořádkový title (decision deck nemá místo na romány). */
const oneLine = (s: string, max = 140): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Stable suffix pro dedup briefing waiting_for ↔ pending_questions. */
const dedupKey = (s: string): string =>
  s.replace(/\s+/g, " ").trim().toLowerCase().slice(-80);

// ─── Resolvery jednotlivých zdrojů ─────────────────────────────────────────

const resolveTask = (row: RawTaskRow, now: Date): DailyLifecycleItem => {
  const escalation = escalationNumber(row.escalation_level);
  const createdToday = isToday(row.created_at, now);
  const overdue = isOverdue(row.due_date, now);

  let status: DailyLifecycleStatus;
  if (row.status === "expired") {
    status = "not_relevant_anymore";
  } else if (row.status === "archived") {
    status = row.completed_at ? "done" : "dropped";
  } else if (escalation >= 1) {
    status = "escalate_to_meeting";
  } else if (overdue) {
    status = "needs_reissue";
  } else if (createdToday) {
    status = "new_today";
  } else {
    status = "waiting_response";
  }

  const isOpen = status !== "done" && status !== "dropped" && status !== "not_relevant_anymore";

  return {
    id: row.id,
    status,
    source: "task",
    audience: assignedToAudience(row.assigned_to),
    title: oneLine(row.task),
    rationale: overdue
      ? `Prošlé due (${row.due_date})`
      : escalation >= 1
      ? `Eskalace ${escalation}`
      : undefined,
    isBlocking: isOpen && (escalation >= 1 || overdue),
    isToday: createdToday,
    createdAt: row.created_at,
    dueAt: row.due_date ?? null,
  };
};

const resolveQuestion = (row: RawPendingQuestionRow, now: Date): DailyLifecycleItem => {
  const createdToday = isToday(row.created_at, now);
  const expired = isExpired(row.expires_at, now);
  const blocking = !!(row.blocking && row.blocking.trim().length > 0);
  const audience = directedToAudience(row.directed_to);

  let status: DailyLifecycleStatus;
  if (row.status === "answered") {
    status = "done";
  } else if (row.status === "archived") {
    status = "dropped";
  } else if (row.status === "expired") {
    status = "not_relevant_anymore";
  } else if (expired) {
    // open ale prošlé expires_at → resolver doporučuje reissue
    status = "needs_reissue";
  } else if (createdToday) {
    status = "new_today";
  } else {
    status = "waiting_response";
  }

  const isOpen = status === "new_today" || status === "waiting_response" || status === "needs_reissue";

  return {
    id: row.id,
    status,
    source: row.crisis_event_id ? "pending_question" : "pending_question",
    audience,
    title: oneLine(row.question),
    rationale: row.subject_type ? `Téma: ${row.subject_type}` : undefined,
    isBlocking: isOpen && blocking,
    isToday: createdToday,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    crisisEventId: row.crisis_event_id ?? null,
  };
};

const resolveCrisisEvent = (row: RawCrisisEventRow, now: Date): DailyLifecycleItem[] => {
  const out: DailyLifecycleItem[] = [];
  if (row.closed_at) {
    // Uzavřená krize do decision decku už nepatří — resolver ji označí jako
    // not_relevant_anymore, ale konzument ji typicky filtruje pryč.
    out.push({
      id: `crisis:${row.id}:closed`,
      status: "not_relevant_anymore",
      source: "crisis_deficit",
      audience: "system",
      title: oneLine(`Krize uzavřena: ${row.part_name}`),
      isBlocking: false,
      isToday: isToday(row.closed_at, now),
      createdAt: row.closed_at,
      partName: row.part_name,
      crisisEventId: row.id,
    });
    return out;
  }

  const morningDoneToday = isToday(row.last_morning_review_at, now);
  const eveningDoneToday = isToday(row.last_evening_decision_at, now);

  if (!morningDoneToday) {
    out.push({
      id: `crisis:${row.id}:morning_missing`,
      status: "new_today",
      source: "crisis_deficit",
      audience: "karel",
      title: oneLine(`Chybí ranní hodnocení krize: ${row.part_name}`),
      rationale: row.severity ? `Závažnost ${row.severity}` : undefined,
      isBlocking: true,
      isToday: true,
      createdAt: now.toISOString(),
      partName: row.part_name,
      crisisEventId: row.id,
    });
  }

  if (!eveningDoneToday) {
    out.push({
      id: `crisis:${row.id}:evening_missing`,
      status: "new_today",
      source: "crisis_deficit",
      audience: "karel",
      title: oneLine(`Chybí večerní rozhodnutí krize: ${row.part_name}`),
      rationale: row.severity ? `Závažnost ${row.severity}` : undefined,
      isBlocking: true,
      isToday: true,
      createdAt: now.toISOString(),
      partName: row.part_name,
      crisisEventId: row.id,
    });
  }

  for (const who of row.awaiting_response_from ?? []) {
    const audience = (who === "hanka" || who === "kata") ? who : "unknown";
    out.push({
      id: `crisis:${row.id}:awaiting:${who}`,
      status: "waiting_response",
      source: "crisis_deficit",
      audience,
      title: oneLine(`Krize ${row.part_name} čeká na ${who}`),
      isBlocking: true,
      isToday: false,
      createdAt: now.toISOString(),
      partName: row.part_name,
      crisisEventId: row.id,
    });
  }

  return out;
};

const resolveSessionProposal = (p: RawSessionProposal, now: Date): DailyLifecycleItem => {
  const createdToday = isToday(p.briefing_date, now);
  const status: DailyLifecycleStatus = p.isScheduled ? "scheduled_for_session" : "new_today";
  return {
    id: p.id || `proposal:${p.part_name}:${p.briefing_date}`,
    status,
    source: "session_proposal",
    audience: "karel",
    title: oneLine(`Návrh sezení: ${p.part_name}`),
    rationale: p.why_today ? oneLine(p.why_today, 100) : undefined,
    isBlocking: status === "new_today",
    isToday: createdToday,
    createdAt: `${p.briefing_date}T08:00:00.000Z`,
    partName: p.part_name,
  };
};

// ─── Hlavní entry point ────────────────────────────────────────────────────

/**
 * Sjednotí vstupy do jednoho DailyLifecycleItem[] a předpočítá UI buckety.
 * Pure funkce — stejný vstup → stejný výstup.
 */
export function resolveDailyLifecycle(input: ResolverInput): DailyLifecycleBuckets {
  const now = input.now ?? new Date();

  const items: DailyLifecycleItem[] = [];

  for (const t of input.tasks ?? []) items.push(resolveTask(t, now));

  // Nejdřív questions, pak briefing waiting (s dedupem proti questions).
  const questionItems = (input.questions ?? []).map((q) => resolveQuestion(q, now));
  items.push(...questionItems);

  const questionDedupKeys = new Set(questionItems.map((q) => dedupKey(q.title)));
  for (const w of input.briefingWaitingFor ?? []) {
    const key = dedupKey(w.text);
    if (questionDedupKeys.has(key)) continue;
    const isTodayItem = w.briefing_date === pragueTodayISO(now);
    items.push({
      id: `briefing_wait:${w.briefing_date}:${key}`,
      status: "waiting_response",
      source: "briefing_ask",
      audience: "unknown",
      title: oneLine(w.text),
      isBlocking: true,
      isToday: isTodayItem,
      createdAt: `${w.briefing_date}T08:00:00.000Z`,
    });
  }

  for (const c of input.crisisEvents ?? []) items.push(...resolveCrisisEvent(c, now));
  for (const p of input.sessionProposals ?? []) items.push(resolveSessionProposal(p, now));

  return bucketize(items);
}

/** Rozdělí items podle status + spočítá decision deck a operativa subsety. */
export function bucketize(items: DailyLifecycleItem[]): DailyLifecycleBuckets {
  const out: DailyLifecycleBuckets = {
    ...EMPTY_BUCKETS,
    newToday: [],
    waitingResponse: [],
    needsReissue: [],
    escalateToMeeting: [],
    scheduledForSession: [],
    done: [],
    dropped: [],
    notRelevantAnymore: [],
    decisionDeck: [],
    operationalToday: [],
  };

  for (const i of items) {
    switch (i.status) {
      case "new_today": out.newToday.push(i); break;
      case "waiting_response": out.waitingResponse.push(i); break;
      case "needs_reissue": out.needsReissue.push(i); break;
      case "escalate_to_meeting": out.escalateToMeeting.push(i); break;
      case "scheduled_for_session": out.scheduledForSession.push(i); break;
      case "done": out.done.push(i); break;
      case "dropped": out.dropped.push(i); break;
      case "not_relevant_anymore": out.notRelevantAnymore.push(i); break;
    }
  }

  // Decision deck = dnešní rozhodovací práce (Slice 2 sekce D).
  out.decisionDeck = [
    ...out.newToday,
    ...out.needsReissue,
    ...out.escalateToMeeting,
    ...out.waitingResponse.filter((i) => i.isBlocking),
  ];

  // Operativa dne = active execution (Slice 2 sekce E).
  out.operationalToday = [
    ...out.waitingResponse,
    ...out.scheduledForSession,
    ...out.needsReissue,
  ];

  // Stabilní seřazení decision decku: blocking nejdřív, pak nejnovější.
  out.decisionDeck.sort((a, b) => {
    if (a.isBlocking !== b.isBlocking) return a.isBlocking ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return out;
}
