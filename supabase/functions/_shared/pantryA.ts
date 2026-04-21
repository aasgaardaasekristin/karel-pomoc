/**
 * pantryA.ts — Spižírna A composer (server-side typed view-model)
 *
 * ARCHITEKTONICKÉ ROZHODNUTÍ (závazné, viz HOURGLASS_CACHE_AUDIT_2026_04_21.md):
 *
 *   Spižírna A NENÍ nová tabulka.
 *   Spižírna A NENÍ rozšířený prompt cache ballast.
 *   Spižírna A JE composed morning view-model nad:
 *     - did_daily_context.context_json   (canonical daily snapshot — source of truth)
 *     - karel_working_memory_snapshots   (derived WM)
 *     - oddělené Hana/Káťa kontexty      (therapist_profiles + karel_hana_conversations)
 *     - pomocné read-model vstupy        (session_memory, did_daily_session_plans, …)
 *
 * Runtime Architecture Lock zůstává platný:
 *   - context_cache = jen prompt-prime cache, NIKDY runtime truth
 *   - Drive = audit/output, ne canonical input
 *
 * Kritické pravidlo:
 *   Hanička osobně a Hanička terapeuticky jsou DVA ODDĚLENÉ SLOTY,
 *   nikdy jeden blob. To vynucuje typesignature `HanaContextSlots`.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  CanonicalCrisisItem,
  CanonicalQueue,
  CanonicalTodaySessionItem,
  composeEmptyCanonicalContext,
} from "./canonicalSnapshot.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface PartStatusRow {
  part_name: string;
  status: string | null;
  cluster: string | null;
  last_emotional_state: string | null;
  last_seen_at: string | null;
}

export interface TherapistStatusRow {
  therapist: "hanka" | "kata";
  mood: string | null;
  stress_level: string | null;
  energy: string | null;
  reliability: string | null;
  current_challenges: string[];
  last_observed_at: string | null;
}

export interface HanaPersonalSlot {
  /** Osobní stavy Hanky — život mimo terapii. */
  recent_personal_signals: string[];
  current_life_situation: string | null;
  last_personal_thread_at: string | null;
  /** Pole `[HANA_PERSONAL]` digestů — nikdy nesmí téct do DID pipeline. */
  personal_thread_count_24h: number;
}

export interface HanaTherapeuticSlot {
  /** Hanička jako terapeutka — supervizní, klinický kontext. */
  current_caseload_focus: string[];
  active_countertransference_bonds: Array<{
    part_name: string;
    bond_type: string;
    intensity: number;
  }>;
  open_supervision_questions: number;
  last_therapeutic_thread_at: string | null;
}

export interface KataTherapeuticSlot {
  current_caseload_focus: string[];
  active_countertransference_bonds: Array<{
    part_name: string;
    bond_type: string;
    intensity: number;
  }>;
  open_supervision_questions: number;
  last_observed_at: string | null;
}

export interface YesterdaySessionResult {
  session_id: string;
  part_name: string | null;
  therapist: string | null;
  summary: string;
  unresolved_topics: string[];
  followup_needs: string[];
  occurred_at: string;
}

export interface OpenFollowup {
  id: string;
  text: string;
  owner: string | null;
  destinations: string[];
  review_at: string | null;
  source_kind: "implication" | "pending_question" | "task";
}

export interface TodayPriority {
  rank: number;
  text: string;
  source: "briefing" | "queue_primary" | "crisis_outputs";
  related_part: string | null;
}

export interface TodayTherapyPlanRow {
  id: string;
  part_name: string | null;
  therapist: string | null;
  proposed_at: string;
  status: string | null;
  urgency_score: number | null;
}

export interface BriefingSlot {
  briefing_date: string;
  is_stale: boolean;
  decisions_count: number;
  generated_at: string;
  /** Raw payload — readers musí používat existing parsers, ne re-implementovat. */
  payload: unknown;
}

export interface PantryASnapshot {
  /** Identification */
  schema_version: 1;
  composed_at: string;
  prague_date: string;
  user_id: string;

  /** Source provenance — kdo a kdy poslední krmil canonical layer. */
  sources: {
    canonical_present: boolean;
    canonical_generated_at: string | null;
    canonical_source: string | null;
    wm_present: boolean;
    wm_generated_at: string | null;
  };

  /** ═══ Canonical pass-through ═══ */
  canonical_crises: CanonicalCrisisItem[];
  canonical_today_session: CanonicalTodaySessionItem | null;
  canonical_queue: CanonicalQueue;

  /** ═══ Doplněné morning sloty ═══ */
  parts_status: PartStatusRow[];
  therapists_status: TherapistStatusRow[];

  /** ─── ODDĚLENÉ kontexty Hany ─── */
  hana_personal: HanaPersonalSlot;
  hana_therapeutic: HanaTherapeuticSlot;
  kata_therapeutic: KataTherapeuticSlot;

  /** Včerejší výsledky sezení */
  yesterday_session_results: YesterdaySessionResult[];

  /** Otevřené follow-upy (implications + pending_questions + open tasks) */
  open_followups: OpenFollowup[];

  /** Dnešní priority — derivace z briefing decisions + canonical_queue */
  today_priorities: TodayPriority[];

  /** Dnešní terapeutický plán (sezení) */
  today_therapy_plan: TodayTherapyPlanRow[];

  /** Briefing payload */
  briefing: BriefingSlot | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

const pragueTodayISO = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(
    new Date(),
  );

const yesterdayISO = (today: string): string => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// ── Composer ────────────────────────────────────────────────────────

/**
 * Postaví ranní pracovní zásobu Karla pro daného uživatele a den.
 *
 * Idempotentní, bez side-effectů. Nezapisuje nikam.
 *
 * Pokud canonical row pro `date` neexistuje, vrací prázdný kostrový
 * snapshot (composeEmptyCanonicalContext semantika) — aby readeři neměli
 * exception path. Volající si chybějící canonical detekuje přes
 * `sources.canonical_present === false`.
 */
export async function selectPantryA(
  sb: SupabaseClient,
  userId: string,
  date: string = pragueTodayISO(),
): Promise<PantryASnapshot> {
  const yesterday = yesterdayISO(date);

  // ── Parallel harvest (Promise.allSettled — jeden broken reader nesmí shodit composer) ──
  const [
    canonicalCtxRes,
    wmRes,
    partsRes,
    therapistProfilesRes,
    hanaConvosRes,
    countertransRes,
    yesterdaySessionsRes,
    yesterdayCtxRes,
    implicationsRes,
    pendingQuestionsRes,
    openTasksRes,
    briefingRes,
    therapyPlanRes,
  ] = await Promise.allSettled([
    sb.from("did_daily_context")
      .select("context_json, generated_at, source")
      .eq("user_id", userId)
      .eq("context_date", date)
      .maybeSingle(),
    sb.from("karel_working_memory_snapshots")
      .select("snapshot_json, generated_at")
      .eq("user_id", userId)
      .eq("snapshot_key", date)
      .maybeSingle(),
    sb.from("did_part_registry")
      .select("part_name, status, cluster, last_emotional_state, last_seen_at")
      .eq("user_id", userId),
    sb.from("therapist_profiles")
      .select("therapist, mood, stress_level, energy, reliability_observations, current_challenges, updated_at")
      .eq("user_id", userId),
    sb.from("karel_hana_conversations")
      .select("id, current_domain, last_activity_at")
      .eq("user_id", userId)
      .gte("last_activity_at", new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()),
    sb.from("did_countertransference_bonds")
      .select("therapist, part_name, bond_type, intensity, last_observed_at")
      .eq("user_id", userId),
    sb.from("session_memory")
      .select("id, part_name, therapist, summary, unresolved_topics, followup_needs, occurred_at")
      .eq("user_id", userId)
      .gte("occurred_at", `${yesterday}T00:00:00Z`)
      .lt("occurred_at", `${date}T00:00:00Z`)
      .order("occurred_at", { ascending: false })
      .limit(10),
    sb.from("did_daily_context")
      .select("context_json, generated_at")
      .eq("user_id", userId)
      .eq("context_date", yesterday)
      .maybeSingle(),
    // Status filter MUSÍ odpovídat reálnému CHECK constraintu tabulky
    // did_implications.status ∈ {'active','done','expired','superseded'}
    // (viz did_implications_status_check). 'active' = otevřená/nevyřešená.
    sb.from("did_implications")
      .select("id, implication_text, owner, destinations, status, review_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(40),
    sb.from("did_pending_questions")
      .select("id, question, directed_to, blocking, created_at")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(30),
    sb.from("did_therapist_tasks")
      .select("id, task, assigned_to, due_date, status, priority")
      .eq("user_id", userId)
      .neq("status", "done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(40),
    sb.from("did_daily_briefings")
      .select("briefing_date, payload, decisions_count, generated_at, is_stale")
      .eq("briefing_date", date)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from("did_daily_session_plans")
      .select("id, part_name, therapist, proposed_at, status, urgency_score")
      .eq("user_id", userId)
      .eq("plan_date", date)
      .order("urgency_score", { ascending: false, nullsFirst: false }),
  ]);

  // ── Unpack with safe fallbacks ──
  const canonical = canonicalCtxRes.status === "fulfilled"
    ? (canonicalCtxRes.value.data ?? null)
    : null;
  const canonicalCtx = canonical?.context_json
    ? (canonical.context_json as Record<string, unknown>)
    : composeEmptyCanonicalContext({ date, source: "pantry_a_fallback" });

  const wm = wmRes.status === "fulfilled" ? (wmRes.value.data ?? null) : null;
  const wmSnap = (wm?.snapshot_json ?? {}) as Record<string, unknown>;

  const partsStatus: PartStatusRow[] = (partsRes.status === "fulfilled"
    ? partsRes.value.data ?? []
    : []) as PartStatusRow[];

  const therapistsRaw = therapistProfilesRes.status === "fulfilled"
    ? therapistProfilesRes.value.data ?? []
    : [];
  const therapistsStatus: TherapistStatusRow[] = (therapistsRaw as any[])
    .filter((r) => r.therapist === "hanka" || r.therapist === "kata")
    .map((r) => ({
      therapist: r.therapist,
      mood: r.mood ?? null,
      stress_level: r.stress_level ?? null,
      energy: r.energy ?? null,
      reliability: r.reliability_observations ?? null,
      current_challenges: Array.isArray(r.current_challenges) ? r.current_challenges : [],
      last_observed_at: r.updated_at ?? null,
    }));

  const hanaConvos = (hanaConvosRes.status === "fulfilled"
    ? hanaConvosRes.value.data ?? []
    : []) as Array<{ current_domain: string | null; last_activity_at: string | null }>;
  const personalConvos = hanaConvos.filter((c) => {
    const d = (c.current_domain || "").toUpperCase();
    return d === "HANA" || d === "PERSONAL" || d === "OSOBNI";
  });
  const therapeuticConvos = hanaConvos.filter((c) => {
    const d = (c.current_domain || "").toUpperCase();
    return d === "DID" || d === "THERAPEUTIC" || d === "TERAPIE";
  });

  const counterRows = (countertransRes.status === "fulfilled"
    ? countertransRes.value.data ?? []
    : []) as Array<{
      therapist: string;
      part_name: string;
      bond_type: string;
      intensity: number;
      last_observed_at: string | null;
    }>;
  const hankaBonds = counterRows
    .filter((b) => b.therapist === "hanka")
    .map((b) => ({ part_name: b.part_name, bond_type: b.bond_type, intensity: b.intensity }));
  const kataBonds = counterRows
    .filter((b) => b.therapist === "kata")
    .map((b) => ({ part_name: b.part_name, bond_type: b.bond_type, intensity: b.intensity }));

  // ── HANA PERSONAL ── striktně oddělený slot
  const hana_personal: HanaPersonalSlot = {
    recent_personal_signals: [],
    current_life_situation: null,
    last_personal_thread_at: personalConvos[0]?.last_activity_at ?? null,
    personal_thread_count_24h: personalConvos.length,
  };

  // ── HANA THERAPEUTIC ── striktně oddělený slot
  const therapistTasks = (openTasksRes.status === "fulfilled"
    ? openTasksRes.value.data ?? []
    : []) as Array<{ id: string; task: string; assigned_to: string | null; due_date: string | null; status: string; priority: string | null }>;
  const hankaTaskFocus = therapistTasks
    .filter((t) => (t.assigned_to || "").toLowerCase() === "hanka")
    .slice(0, 5)
    .map((t) => t.task);
  const kataTaskFocus = therapistTasks
    .filter((t) => (t.assigned_to || "").toLowerCase() === "kata")
    .slice(0, 5)
    .map((t) => t.task);

  const pendingQs = (pendingQuestionsRes.status === "fulfilled"
    ? pendingQuestionsRes.value.data ?? []
    : []) as Array<{ id: string; question: string; directed_to: string | null; blocking: boolean | null; created_at: string }>;
  const hankaOpenQs = pendingQs.filter((q) => (q.directed_to || "").toLowerCase().includes("hank")).length;
  const kataOpenQs = pendingQs.filter((q) => (q.directed_to || "").toLowerCase().includes("kat")).length;

  const hana_therapeutic: HanaTherapeuticSlot = {
    current_caseload_focus: hankaTaskFocus,
    active_countertransference_bonds: hankaBonds,
    open_supervision_questions: hankaOpenQs,
    last_therapeutic_thread_at: therapeuticConvos[0]?.last_activity_at ?? null,
  };

  const kata_therapeutic: KataTherapeuticSlot = {
    current_caseload_focus: kataTaskFocus,
    active_countertransference_bonds: kataBonds,
    open_supervision_questions: kataOpenQs,
    last_observed_at: counterRows.find((b) => b.therapist === "kata")?.last_observed_at ?? null,
  };

  // ── YESTERDAY SESSIONS ──
  const ySessions = (yesterdaySessionsRes.status === "fulfilled"
    ? yesterdaySessionsRes.value.data ?? []
    : []) as any[];
  const yesterday_session_results: YesterdaySessionResult[] = ySessions.map((s) => ({
    session_id: s.id,
    part_name: s.part_name ?? null,
    therapist: s.therapist ?? null,
    summary: s.summary ?? "",
    unresolved_topics: Array.isArray(s.unresolved_topics) ? s.unresolved_topics : [],
    followup_needs: Array.isArray(s.followup_needs) ? s.followup_needs : [],
    occurred_at: s.occurred_at,
  }));

  // ── OPEN FOLLOWUPS ── union implications + pending_questions + open tasks
  const impls = (implicationsRes.status === "fulfilled"
    ? implicationsRes.value.data ?? []
    : []) as Array<{ id: string; implication_text: string; owner: string | null; destinations: string[] | null; review_at: string | null }>;
  const open_followups: OpenFollowup[] = [
    ...impls.map((i) => ({
      id: i.id,
      text: i.implication_text,
      owner: i.owner,
      destinations: i.destinations ?? [],
      review_at: i.review_at,
      source_kind: "implication" as const,
    })),
    ...pendingQs.map((q) => ({
      id: q.id,
      text: q.question,
      owner: q.directed_to,
      destinations: [],
      review_at: null,
      source_kind: "pending_question" as const,
    })),
    ...therapistTasks
      .filter((t) => t.priority === "high" || t.priority === "urgent")
      .slice(0, 20)
      .map((t) => ({
        id: t.id,
        text: t.task,
        owner: t.assigned_to,
        destinations: [],
        review_at: t.due_date,
        source_kind: "task" as const,
      })),
  ];

  // ── TODAY PRIORITIES ── briefing decisions + canonical queue primary
  const briefing = briefingRes.status === "fulfilled" ? (briefingRes.value.data ?? null) : null;
  const briefingPayload = (briefing?.payload ?? {}) as Record<string, unknown>;
  const briefingDecisions = Array.isArray(briefingPayload.decisions)
    ? (briefingPayload.decisions as Array<{ text?: string; related_part?: string }>)
    : [];

  const queueRaw = (canonicalCtx.canonical_queue ?? {}) as Record<string, unknown>;
  const queuePrimary = Array.isArray(queueRaw.primary)
    ? (queueRaw.primary as Array<{ text: string; section: string | null }>)
    : [];

  const today_priorities: TodayPriority[] = [
    ...briefingDecisions.slice(0, 5).map((d, i) => ({
      rank: i + 1,
      text: d.text || "",
      source: "briefing" as const,
      related_part: d.related_part ?? null,
    })),
    ...queuePrimary.slice(0, 5).map((q, i) => ({
      rank: briefingDecisions.length + i + 1,
      text: q.text,
      source: "queue_primary" as const,
      related_part: null,
    })),
  ].filter((p) => p.text);

  // ── TODAY THERAPY PLAN ──
  const today_therapy_plan = (therapyPlanRes.status === "fulfilled"
    ? (therapyPlanRes.value.data ?? [])
    : []) as TodayTherapyPlanRow[];

  // ── COMPOSE ──
  const canonicalCrises = Array.isArray(canonicalCtx.canonical_crises)
    ? (canonicalCtx.canonical_crises as CanonicalCrisisItem[])
    : [];
  const canonicalToday = (canonicalCtx.canonical_today_session ?? null) as
    | CanonicalTodaySessionItem
    | null;
  const canonicalQueue = (canonicalCtx.canonical_queue ?? {
    primary: [],
    adjunct: [],
    primary_count: 0,
    adjunct_count: 0,
  }) as CanonicalQueue;

  return {
    schema_version: 1,
    composed_at: new Date().toISOString(),
    prague_date: date,
    user_id: userId,
    sources: {
      canonical_present: !!canonical,
      canonical_generated_at: canonical?.generated_at ?? null,
      canonical_source: canonical?.source ?? null,
      wm_present: !!wm,
      wm_generated_at: wm?.generated_at ?? null,
    },
    canonical_crises: canonicalCrises,
    canonical_today_session: canonicalToday,
    canonical_queue: canonicalQueue,
    parts_status: partsStatus,
    therapists_status: therapistsStatus,
    hana_personal,
    hana_therapeutic,
    kata_therapeutic,
    yesterday_session_results,
    open_followups,
    today_priorities,
    today_therapy_plan,
    briefing: briefing
      ? {
          briefing_date: briefing.briefing_date,
          is_stale: briefing.is_stale,
          decisions_count: briefing.decisions_count,
          generated_at: briefing.generated_at,
          payload: briefing.payload,
        }
      : null,
    // Suppress unused warning — wmSnap reserved for future enrichment
    ...(false as any && { _wm: wmSnap }),
  };
}

/**
 * Lightweight summary for prompt injection (token-frugal).
 * Composer výstup `selectPantryA` může být přímo logován do briefingu;
 * `summarizePantryAForPrompt` vrací stručný textový blok pro AI prompty.
 */
export function summarizePantryAForPrompt(snap: PantryASnapshot): string {
  const parts: string[] = [];
  parts.push(`# Spižírna A — ${snap.prague_date} (composed ${snap.composed_at.slice(11, 16)} UTC)`);
  parts.push(
    `## Zdroje\ncanonical: ${snap.sources.canonical_present ? "ano" : "CHYBÍ"}, ` +
      `wm: ${snap.sources.wm_present ? "ano" : "CHYBÍ"}`,
  );
  parts.push(
    `## Krize (${snap.canonical_crises.length})\n` +
      snap.canonical_crises.map((c) => `- ${c.partName} [${c.severity ?? "?"}] phase=${c.phase}`).join("\n"),
  );
  parts.push(
    `## Dnešní priority\n` +
      snap.today_priorities.map((p) => `${p.rank}. (${p.source}) ${p.text}`).join("\n"),
  );
  parts.push(
    `## Hana — OSOBNĚ (oddělený slot, NIKDY do DID pipeline)\n` +
      `život: ${snap.hana_personal.current_life_situation ?? "—"}, ` +
      `osobní vlákna 24h: ${snap.hana_personal.personal_thread_count_24h}`,
  );
  parts.push(
    `## Hana — TERAPEUTICKY\n` +
      `focus: ${snap.hana_therapeutic.current_caseload_focus.slice(0, 3).join(" | ") || "—"}, ` +
      `otevřené otázky: ${snap.hana_therapeutic.open_supervision_questions}, ` +
      `bonds: ${snap.hana_therapeutic.active_countertransference_bonds.length}`,
  );
  parts.push(
    `## Káťa — TERAPEUTICKY\n` +
      `focus: ${snap.kata_therapeutic.current_caseload_focus.slice(0, 3).join(" | ") || "—"}, ` +
      `otevřené otázky: ${snap.kata_therapeutic.open_supervision_questions}, ` +
      `bonds: ${snap.kata_therapeutic.active_countertransference_bonds.length}`,
  );
  parts.push(
    `## Včerejší sezení (${snap.yesterday_session_results.length})\n` +
      snap.yesterday_session_results
        .map((s) => `- ${s.part_name ?? "?"} (${s.therapist ?? "?"}): ${s.summary.slice(0, 120)}`)
        .join("\n"),
  );
  parts.push(
    `## Open follow-ups (${snap.open_followups.length})\n` +
      snap.open_followups.slice(0, 10).map((f) => `- [${f.source_kind}] ${f.text.slice(0, 140)}`).join("\n"),
  );
  return parts.join("\n\n");
}
