/**
 * karel-did-daily-briefing
 *
 * Generuje kanonický denní briefing Karla.
 * Briefing je redakční artefakt — vzniká jednou denně, ukládá se do
 * `did_daily_briefings`, dashboard ho jen čte.
 *
 * Generation methods (uloženo do `did_daily_briefings.generation_method`):
 *   - "auto"   → ranní cron (job `did-daily-briefing-morning`, viz pg_cron)
 *   - "manual" → tlačítko `Přegenerovat` v UI (DidDailyBriefingPanel)
 *
 * Anti-dup: pokud existuje fresh (is_stale=false) briefing pro dnešek
 * a request nemá `force: true`, vrátí se cached. Cron volá BEZ `force`,
 * takže neudusí ruční briefing, pokud už existuje. Manuální regenerace
 * posílá `force: true`.
 *
 * Workflow:
 * 1. Načti kontext: aktivní krize, signály z posledních 3 dnů, otevřené tasky, parts
 * 2. Spočítej skóre kandidátů na dnešní sezení (heuristika)
 * 3. Pošli AI strukturovaný kontext + tool-call schema
 * 4. Ulož výsledek do did_daily_briefings
 *
 * Tone: kultivovaná čeština, jungovská noblesa v úvodu/přechodech,
 * konkrétní pracovní formulace v rozhodovacích bodech.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import { selectPantryA, summarizePantryAForPrompt, type PantryASnapshot } from "../_shared/pantryA.ts";
import { readUnprocessedPantryB, markPantryBProcessed } from "../_shared/pantryB.ts";
import { summarizeToolboxForPrompt } from "../_shared/therapeuticToolbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";

const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return pragueDayISO(d);
};

const normalizeTherapistLabel = (value: unknown): "Hanička" | "Káťa" | "společně" | undefined => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("spol") || raw.includes("oba") || raw.includes("both")) return "společně";
  if (raw.includes("han") || raw.includes("hanka")) return "Hanička";
  if (raw.includes("kat") || raw.includes("káťa") || raw.includes("kata")) return "Káťa";
  return undefined;
};

const cleanBlockText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\r/g, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const extractMarkdownSection = (markdown: string, heading: string): string => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"));
  return cleanBlockText(match?.[1] ?? "");
};

const extractMarkdownSectionByPrefix = (markdown: string, prefix: string): string => {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`###\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"));
  return cleanBlockText(match?.[1] ?? "");
};

const mergeUniqueParagraphs = (...chunks: Array<unknown>): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks) {
    const text = cleanBlockText(chunk);
    if (!text) continue;
    for (const paragraph of text.split(/\n\n+/)) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join("\n\n");
};

const jsonItemCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 0;
};

const getResolvedPartCardEvidence = (review: any): any | null => {
  const items = Array.isArray(review?.evidence_items) ? review.evidence_items : [];
  return items.find((item: any) =>
    item?.kind === "part_card"
    && item?.available === true
    && String(item?.lookup_status ?? "").toLowerCase() === "resolved"
  ) ?? null;
};

const partCardMissingPattern = /(part\s*card\s*(chyb|missing)|chyb[íi]\s+(?:part\s*card|karta|kartu|karty)|karta\s+[^.!?\n]{0,80}\s+chyb[íi]|absence\s+karty|založit\s+kartu|kartu\s+pro\s+část\s+arthur|je\s+nutn[ée]\s+založit\s+kartu)/i;

const stripContradictoryPartCardText = (value: unknown, partCard: any | null): string => {
  const text = cleanBlockText(value);
  if (!text || !partCard) return text;
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !partCardMissingPattern.test(sentence))
    .join(" ")
    .trim();
};

const buildBriefingEvidenceLimitations = (review: any): string => {
  const partCard = getResolvedPartCardEvidence(review);
  const base = stripContradictoryPartCardText(review?.evidence_limitations, partCard);
  const validityLimits = "chybí turn-by-turn data, transcript, observations/audio a plný průběh sezení";

  if (partCard) {
    const canonical = String(partCard?.canonical_part_name ?? partCard?.part_name ?? review?.part_name ?? "část").trim();
    return mergeUniqueParagraphs(
      base,
      `Karta / registry záznam části byl dohledán jako ${canonical}. Evidence je nadále omezená nikoli kvůli chybějící kartě, ale kvůli tomu, že ${validityLimits}.`,
      "Evidence-limited hardening: závěry jsou pracovní a Karel nepředstírá plnou analýzu.",
    );
  }

  return mergeUniqueParagraphs(
    base || "Validita je omezená; závěry jsou pracovní hypotézy.",
    `Evidence-limited hardening: ${validityLimits}; závěry jsou pracovní a Karel nepředstírá plnou analýzu.`,
  );
};

function reviewOutcome(review: any): string {
  return String(review?.analysis_json?.outcome ?? review?.analysis_json?.post_session_result?.status ?? "").trim();
}

function reviewEvidenceBasis(review: any): "planned_only" | "started_partial" | "completed" | "unknown" {
  const outcome = reviewOutcome(review);
  if (outcome === "planned_not_started") return "planned_only";
  const items = Array.isArray(review?.evidence_items) ? review.evidence_items : [];
  const hasStartedEvidence = items.some((e: any) =>
    (e?.kind === "live_progress" && e?.available && Number(e?.completed_blocks ?? 0) > 0) ||
    (e?.kind === "turn_by_turn" && e?.available) ||
    (e?.kind === "observations" && e?.available) ||
    (e?.kind === "thread_transcript" && e?.available && Number(e?.thread_count ?? 0) > 0) ||
    (e?.kind === "session_started_evidence" && e?.available)
  );
  if (review?.status === "analyzed" && hasStartedEvidence) return "completed";
  if (hasStartedEvidence) return "started_partial";
  return "unknown";
}

function enrichYesterdaySessionReview(payload: any, context: any) {
  const reviews = Array.isArray(context?.yesterday_session_reviews) ? context.yesterday_session_reviews : [];
  const sessionReviews = reviews.filter((r: any) => String(r?.mode ?? "session") !== "playroom");
  const clinicalReviews = sessionReviews.filter((r: any) => ["started_partial", "completed"].includes(reviewEvidenceBasis(r)));
  // Non-playroom session review je autoritativní stopa včerejšího sezení i tehdy,
  // když chybí did_part_sessions nebo evidence_basis vyjde unknown/evidence_limited.
  const latestReview = clinicalReviews[0] ?? sessionReviews[0] ?? null;
  const latestSession = latestReview && Array.isArray(context?.yesterday_sessions)
    ? context.yesterday_sessions.find((s: any) => String(s?.part_name ?? "").toLowerCase() === String(latestReview.part_name ?? "").toLowerCase()) ?? null
    : null;
  const plannedOnly = sessionReviews.find((r: any) => reviewEvidenceBasis(r) === "planned_only");

  if (!latestSession && !latestReview) {
    if (plannedOnly) {
      payload.yesterday_session_review = {
        held: false,
        part_name: plannedOnly.part_name,
        review_status: plannedOnly.status,
        completion: "abandoned",
        evidence_limited: true,
        evidence_basis: "planned_only",
        evidence_limitations: plannedOnly.evidence_limitations,
        review_id: plannedOnly.id,
        plan_id: plannedOnly.plan_id,
        karel_summary: plannedOnly.clinical_summary,
        key_finding_about_part: "Nelze dělat závěr o prožívání části, protože není evidence zahájení sezení.",
        implications_for_plan: plannedOnly.therapeutic_implications ?? "Ověřit u terapeutky, zda se pokus skutečně odehrál.",
        team_acknowledgement: "Bez záznamu terapeutické akce nelze hodnotit práci terapeutky.",
      };
    }
    return payload;
  }

  const review = payload?.yesterday_session_review && typeof payload.yesterday_session_review === "object"
    ? { ...payload.yesterday_session_review }
    : {};

  const analysis = String(latestSession?.ai_analysis ?? latestReview?.clinical_summary ?? "");
  const sessionArc = extractMarkdownSection(analysis, "Oblouk sezení");
  const childPerspective = extractMarkdownSectionByPrefix(analysis, "Z pohledu");
  const keyInsights = extractMarkdownSection(analysis, "Klíčové závěry");
  const implications = extractMarkdownSection(analysis, "Co z toho plyne pro další postup");
  const therapistWork = extractMarkdownSection(analysis, "Práce terapeutky");
  const completedCount = jsonItemCount(latestReview?.completed_checklist_items);
  const missingCount = jsonItemCount(latestReview?.missing_checklist_items);
  const totalCount = completedCount + missingCount;
  const evidenceLabel = totalCount > 0 ? `${completedCount}/${totalCount} checklist položek` : undefined;
  const partCard = getResolvedPartCardEvidence(latestReview);
  const evidenceLimit = latestReview ? buildBriefingEvidenceLimitations(latestReview) : review.evidence_limitations;
  const clinicalSummary = stripContradictoryPartCardText(latestReview?.clinical_summary, partCard);
  const evidenceBasis = latestReview ? reviewEvidenceBasis(latestReview) : review.evidence_basis;
  const statusLine = latestReview
    ? `Stav review: ${latestReview.status}; evidence_basis: ${evidenceBasis}; evidence ${evidenceLabel ?? "neúplná"}. ${evidenceLimit}`
    : "";

  payload.yesterday_session_review = {
    held: true,
    part_name: String(latestReview?.part_name ?? latestSession?.part_name ?? review.part_name ?? "").trim() || undefined,
    lead: normalizeTherapistLabel(latestSession?.therapist ?? review.lead) ?? review.lead,
    review_status: latestReview?.status ?? review.review_status,
    completion: evidenceBasis === "completed" ? "completed" : latestReview?.status === "partially_analyzed" ? "partial" : latestReview?.status === "evidence_limited" ? "partial" : (review.completion ?? "partial"),
    completed_checklist_count: latestReview ? completedCount : review.completed_checklist_count,
    total_checklist_count: latestReview ? totalCount : review.total_checklist_count,
    evidence_label: evidenceLabel ?? review.evidence_label,
    evidence_limited: latestReview ? latestReview.status !== "analyzed" : review.evidence_limited,
    evidence_basis: evidenceBasis,
    evidence_limitations: latestReview ? evidenceLimit : review.evidence_limitations,
    review_id: latestReview?.id ?? review.review_id,
    plan_id: latestReview?.plan_id ?? review.plan_id,
    karel_summary: mergeUniqueParagraphs(
      statusLine,
      latestSession?.karel_notes,
      sessionArc,
      childPerspective,
      clinicalSummary,
      review.karel_summary,
    ),
    key_finding_about_part: mergeUniqueParagraphs(
      keyInsights,
      review.key_finding_about_part,
    ),
    implications_for_plan: mergeUniqueParagraphs(
      latestSession?.handoff_note,
      implications,
      latestReview?.therapeutic_implications,
      review.implications_for_plan,
    ),
    team_acknowledgement: mergeUniqueParagraphs(
      latestSession?.karel_therapist_feedback,
      therapistWork,
      review.team_acknowledgement,
    ),
  };

  return payload;
}

// ───────────────────────────────────────────────────────────
// HEURISTIKA: skórování kandidátů na dnešní sezení
// ───────────────────────────────────────────────────────────
interface SessionCandidate {
  part_id: string;
  part_name: string;
  score: number;
  reasons: string[];
}

async function scoreSessionCandidates(supabase: any): Promise<SessionCandidate[]> {
  const threeDaysAgo = daysAgoISO(3);
  const candidates = new Map<string, SessionCandidate>();

  const ensure = (part_id: string, part_name: string): SessionCandidate => {
    if (!candidates.has(part_id)) {
      candidates.set(part_id, { part_id, part_name, score: 0, reasons: [] });
    }
    return candidates.get(part_id)!;
  };

  // 1) Aktivní krize (×3)
  const { data: crises } = await supabase
    .from("crisis_events")
    .select("id, part_name, severity, phase, indicator_safety, indicator_emotional_regulation")
    .not("phase", "in", '("closed","CLOSED")');

  for (const c of crises || []) {
    // PROPOSAL-TO-DNES TRUTH PASS: kanonická tabulka částí je did_part_registry,
    // pole part_name (ne `name`). Předchozí volání `did_parts` tiše failovalo a
    // tím pádem scorer vždy vracel 0 kandidátů → briefing nikdy nenavrhl sezení.
    // Použít limit(1) místo maybeSingle() — registr může mít víc řádků (per user, case).
    const { data: parts } = await supabase
      .from("did_part_registry")
      .select("id, part_name")
      .ilike("part_name", c.part_name)
      .limit(1);
    const part = parts?.[0];
    if (!part) continue;
    const cand = ensure(part.id, part.part_name);
    cand.score += 3;
    cand.reasons.push(`aktivní krize (${c.severity || "?"}, fáze ${c.phase || "?"})`);
    if ((c.indicator_safety ?? 5) <= 2) {
      cand.score += 2;
      cand.reasons.push("nízký bezpečnostní indikátor");
    }
  }

  // 2) Opakované signály z posledních 3 dnů (×2)
  const { data: recentObs } = await supabase
    .from("did_observations")
    .select("part_id, severity, signal_type")
    .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(100);

  const obsCounts = new Map<string, number>();
  for (const o of recentObs || []) {
    if (!o.part_id) continue;
    obsCounts.set(o.part_id, (obsCounts.get(o.part_id) || 0) + 1);
  }
  for (const [part_id, count] of obsCounts) {
    if (count >= 2) {
      const { data: part } = await supabase.from("did_part_registry").select("id, part_name").eq("id", part_id).maybeSingle();
      if (!part) continue;
      const cand = ensure(part.id, part.part_name);
      cand.score += Math.min(count, 4);
      cand.reasons.push(`${count} signálů za 3 dny`);
    }
  }

  // 3) Pending questions bez odpovědi (×1)
  const { data: pending } = await supabase
    .from("did_pending_questions")
    .select("part_id")
    .in("status", ["pending", "sent"]);

  for (const p of pending || []) {
    if (!p.part_id) continue;
    const { data: part } = await supabase.from("did_part_registry").select("id, part_name").eq("id", p.part_id).maybeSingle();
    if (!part) continue;
    const cand = ensure(part.id, part.part_name);
    cand.score += 1;
    cand.reasons.push("nedořešená otázka");
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score);
}

// ───────────────────────────────────────────────────────────
// KONTEXT: posledních 3 dní + lingering
// ───────────────────────────────────────────────────────────
async function gatherContext(supabase: any) {
  const threeDaysAgo = daysAgoISO(3);
  const sevenDaysAgo = daysAgoISO(7);
  const yesterdayISO = daysAgoISO(1);

  const [crisesRes, recentObsRes, olderObsRes, pendingRes, threadsRes, plansRes, yesterdaySessionsRes, yesterdayPlansRes] = await Promise.all([
    supabase.from("crisis_events")
      .select("id, part_name, severity, phase, trigger_description, days_active, opened_at, clinical_summary")
      .not("phase", "in", '("closed","CLOSED")')
      .order("severity", { ascending: false }),
    supabase.from("did_observations")
      .select("subject_type, subject_id, fact, evidence_level, confidence, created_at")
      .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
      .order("created_at", { ascending: false })
      .limit(80),
    supabase.from("did_observations")
      .select("subject_type, subject_id, fact, evidence_level, confidence, created_at")
      .gte("created_at", `${sevenDaysAgo}T00:00:00Z`)
      .lt("created_at", `${threeDaysAgo}T00:00:00Z`)
      .in("evidence_level", ["D1", "D2", "D3", "I1"])
      .limit(30),
    supabase.from("did_pending_questions")
      .select("id, subject_type, subject_id, question, directed_to, status")
      .in("status", ["open", "pending", "sent"])
      .limit(20),
    supabase.from("did_threads")
      .select("id, thread_label, part_name, last_activity_at")
      .gte("last_activity_at", `${threeDaysAgo}T00:00:00Z`)
      .order("last_activity_at", { ascending: false })
      .limit(15),
    supabase.from("did_daily_session_plans")
      .select("id, plan_date, selected_part, therapist, status, plan_markdown, crisis_event_id")
      .gte("plan_date", threeDaysAgo)
      .order("plan_date", { ascending: false }),
    // Včerejší sezení s vyhodnocením (pro yesterday_session_review)
    supabase.from("did_part_sessions")
      .select("id, part_name, therapist, session_date, session_type, ai_analysis, methods_used, methods_effectiveness, karel_notes, karel_therapist_feedback, handoff_note, tasks_assigned")
      .eq("session_date", yesterdayISO)
      .order("created_at", { ascending: false })
      .limit(5),
    // Včerejší plány (i in_progress, abychom poznali částečné sezení)
    supabase.from("did_daily_session_plans")
      .select("id, plan_date, selected_part, therapist, session_lead, status, completed_at, plan_markdown")
      .eq("plan_date", yesterdayISO)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const { data: parts } = await supabase
    .from("did_part_registry")
    .select("id, part_name");
  const partsById = new Map((parts || []).map((p: any) => [p.id, p.part_name]));

  // ═══ HOURGLASS: SPIŽÍRNA A READER (briefing) ═══
  // Reálný konzument composed morning view-modelu. Briefing už netahá vše
  // ručně — Pantry A přidává canonical priority, parts/therapists status,
  // oddělené Hana personal vs. therapeutic sloty, Káťa kontext, včerejší
  // sezení a otevřené follow-upy. Vlastní gather query výše zůstávají
  // jako safety net pro případ, že canonical layer dnes neexistuje.
  let pantryA: PantryASnapshot | null = null;
  let pantryASummary = "";
  try {
    const { data: anyCtxRow } = await supabase
      .from("did_daily_context")
      .select("user_id")
      .order("context_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const userId = anyCtxRow?.user_id;
    if (userId) {
      pantryA = await selectPantryA(supabase, userId);
      pantryASummary = summarizePantryAForPrompt(pantryA);
      console.log(`[briefing] Pantry A loaded: canonical_present=${pantryA.sources.canonical_present}, parts=${pantryA.parts_status.length}, followups=${pantryA.open_followups.length}, priorities=${pantryA.today_priorities.length}`);
    } else {
      console.warn("[briefing] Pantry A skipped: no user_id resolvable from did_daily_context");
    }
  } catch (pErr) {
    console.warn("[briefing] Pantry A load failed (non-fatal):", pErr);
  }

  // ═══ PANTRY B READER (briefing) ═══
  // Sběr nezpracovaných implikací z včerejška + dnešního rána.
  // Zdroje: signoff/synthesis (porady), did-meeting finalize, apply-analysis,
  // post-chat writebacky. Bez tohoto kroku Karel nevidí, co včera ve vláknech /
  // poradách / sezeních vyplynulo, a briefing zní jako kdyby den začínal odznova.
  let pantryBEntries: any[] = [];
  let approvedDeliberations: any[] = [];
  try {
    const userIdForB: string | null = null;
    let userIdResolved: string | null = userIdForB;
    if (!userIdResolved) {
      const { data: anyCtxRow } = await supabase
        .from("did_daily_context")
        .select("user_id")
        .order("context_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      userIdResolved = anyCtxRow?.user_id ?? null;
    }
    if (userIdResolved) {
      pantryBEntries = await readUnprocessedPantryB(supabase, userIdResolved);
      const { data: approved } = await supabase
        .from("did_team_deliberations")
        .select("id, title, deliberation_type, subject_parts, status, final_summary, karel_synthesis, questions_for_hanka, questions_for_kata, discussion_log, updated_at")
        .eq("user_id", userIdResolved)
        .in("status", ["approved", "awaiting_signoff", "active"])
        .gte("updated_at", `${daysAgoISO(7)}T00:00:00Z`)
        .order("updated_at", { ascending: false })
        .limit(20);
      approvedDeliberations = approved ?? [];
      console.log(`[briefing] Pantry B loaded: entries=${pantryBEntries.length}, approved_delibs=${approvedDeliberations.length}`);
    }
  } catch (bErr) {
    console.warn("[briefing] Pantry B / approved deliberations load failed (non-fatal):", bErr);
  }

  // ── Včerejší sezení (pro yesterday_session_review) ──
  const yesterdaySessions = (yesterdaySessionsRes.data || []) as any[];
  const yesterdayPlans = (yesterdayPlansRes.data || []) as any[];
  const yesterdayPlanIds = yesterdayPlans.map((p: any) => p?.id).filter((id: any) => typeof id === "string");
  let yesterdaySessionReviews: any[] = [];
  if (yesterdayPlanIds.length > 0) {
    const { data: reviews } = await supabase
      .from("did_session_reviews")
      .select("id, plan_id, mode, status, part_name, clinical_summary, therapeutic_implications, team_implications, evidence_limitations, evidence_items, completed_checklist_items, missing_checklist_items, source_data_summary, analysis_json, created_at")
      .in("plan_id", yesterdayPlanIds)
      .eq("is_current", true)
      .order("created_at", { ascending: false })
      .limit(5);
    const allReviews = (reviews ?? []).filter((r: any) => String(r?.mode ?? "session") !== "playroom");
    const rank = (r: any) => {
      const basis = reviewEvidenceBasis(r);
      if (basis === "completed") return 0;
      if (basis === "started_partial") return 1;
      if (basis === "planned_only") return 3;
      return 2;
    };
    yesterdaySessionReviews = allReviews.sort((a: any, b: any) => rank(a) - rank(b));
  }
  const clinicalReviewParts = new Set(yesterdaySessionReviews.filter((r: any) => ["completed", "started_partial", "unknown"].includes(reviewEvidenceBasis(r))).map((r: any) => String(r.part_name ?? "").toLowerCase()));
  const safeYesterdaySessions = clinicalReviewParts.size > 0
    ? yesterdaySessions.filter((s: any) => clinicalReviewParts.has(String(s.part_name ?? "").toLowerCase()))
    : [];

  return {
    today: pragueDayISO(),
    yesterday: yesterdayISO,
    crises: crisesRes.data || [],
    recent_observations: (recentObsRes.data || []).map((o: any) => ({
      ...o,
      part_name: o.subject_type === "part" ? o.subject_id : null,
      content: o.fact,
      severity: o.evidence_level,
    })),
    older_significant: (olderObsRes.data || []).map((o: any) => ({
      ...o,
      part_name: o.subject_type === "part" ? o.subject_id : null,
      content: o.fact,
      severity: o.evidence_level,
    })),
    pending_questions: (pendingRes.data || []).map((q: any) => ({
      ...q,
      part_name: q.subject_type === "part" ? q.subject_id : null,
      asked_to: q.directed_to,
    })),
    recent_threads: threadsRes.data || [],
    recent_session_plans: (plansRes.data || []).map((p: any) => ({
      ...p,
      part_name: p.selected_part ?? null,
      session_date: p.plan_date,
    })),
    yesterday_sessions: safeYesterdaySessions,
    yesterday_plans: yesterdayPlans,
    yesterday_session_reviews: yesterdaySessionReviews,
    pantry_a: pantryA,
    pantry_a_summary: pantryASummary,
    pantry_b_entries: pantryBEntries,
    approved_deliberations: approvedDeliberations,
  };
}

// ───────────────────────────────────────────────────────────
// AI: strukturovaný briefing přes tool calling
// ───────────────────────────────────────────────────────────
const BRIEFING_TOOL = {
  type: "function",
  function: {
    name: "emit_daily_briefing",
    description: "Vrátí strukturovaný denní briefing Karla pro dashboardovou poradu týmu.",
    parameters: {
      type: "object",
      properties: {
        greeting: {
          type: "string",
          description: "Karlovo úvodní slovo (2-4 věty). Kultivovaná čeština, jungovská noblesa. Pozdrav Haničce a Káte, dnešní hlavní priorita, proč je důležitá. Bez patosu.",
        },
        last_3_days: {
          type: "string",
          description: "Syntéza posledních 3 dnů (2-4 věty, ne raw log). Co se změnilo, jaké linie se ukazují. Konkrétní jména částí, ne 'systém'.",
        },
        lingering: {
          type: "string",
          description: "Co zůstává významné z dřívějška (1-3 věty). Jen skutečně relevantní věci, ne všechno staré.",
        },
        yesterday_session_review: {
          type: "object",
          description:
            "KLINICKÉ PŘETLUMOČENÍ včerejšího sezení Karlovým hlasem — NE provozní zpráva, NE výpis kroků, NE „co se programově dělo“. " +
            "Karel mluví jako vedoucí týmu, který právě dočetl analýzu a teď ji vrací zpátky Hance a Káte v lidské řeči. " +
            "Pokud včera žádné sezení nebylo, nech klíč null. Pokud bylo přerušené nebo částečné, neříkej, že proběhlo celé.",
          properties: {
            held: { type: "boolean", description: "True pokud včera proběhlo aspoň částečné sezení." },
            part_name: { type: "string" },
            lead: { type: "string", enum: ["Hanička", "Káťa", "společně"] },
            review_status: { type: "string", description: "Stav review, např. partially_analyzed." },
            completion: { type: "string", enum: ["completed", "partial", "abandoned"] },
            completed_checklist_count: { type: "number" },
            total_checklist_count: { type: "number" },
            evidence_label: { type: "string", description: "Krátká evidence značka, např. 1/5 checklist položek." },
            evidence_limited: { type: "boolean" },
            evidence_limitations: { type: "string" },
            review_id: { type: "string" },
            plan_id: { type: "string" },
            karel_summary: {
              type: "string",
              description:
                "PRIMÁRNÍ — 4–7 vět Karlova přetlumočení. CO SE VČERA OPRAVDU UKÁZALO — celkový oblouk, klima, atmosféra, " +
                "kvalita kontaktu mezi částí a terapeutkou. NE seznam programových bodů. Mluv o smyslu, ne o průběhu. " +
                "Konkrétní jméno části, žádný „systém“, žádný „klient“.",
            },
            key_finding_about_part: {
              type: "string",
              description:
                "DŮLEŽITÉ KLINICKÉ ZJIŠTĚNÍ O ČÁSTI — 2–4 věty. Co nového / přesnějšího teď víme o této části: " +
                "její potřeba, obrana, vývojová úroveň, vztahový vzorec, spouštěč, zdroj. " +
                "Pojmenuj to jako klinický posun v porozumění, ne jako popis epizody.",
            },
            implications_for_plan: {
              type: "string",
              description:
                "CO Z TOHO PLYNE PRO TERAPEUTICKÝ PLÁN — 2–4 věty. Konkrétní úprava směru práce s touto částí: " +
                "co přidat, co opustit, co zpomalit, jaký formát příště zvolit, na co si dát pozor. " +
                "Mluv jako klinik, ne jako provozák.",
            },
            team_acknowledgement: {
              type: "string",
              description:
                "PODĚKOVÁNÍ A STMELENÍ TÝMU — 1–3 věty osobně adresované terapeutce/terapeutkám, které sezení vedly. " +
                "Konkrétně pojmenuj, co udělaly dobře (klid, trpělivost, intuitivní rozhodnutí, zvládnutí přerušení). " +
                "Bez patosu, bez floskulí. Pokud sezení vedla jen jedna z nich, oslov jen ji.",
            },
          },
          required: ["held", "karel_summary", "key_finding_about_part", "implications_for_plan", "team_acknowledgement"],
          additionalProperties: false,
        },
        decisions: {
          type: "array",
          description: "Společná rozhodnutí pro dnešek. MAX 2 položky, +1 navíc jen pokud je crisis (= max 3 celkem). Konkrétní rozhodovací názvy, NE generické 'koordinovat strategii'. ID NEDOPLŇUJ — server přidá.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Krátký konkrétní rozhodovací název, např. 'Dnešní krizový plán pro Arthura'." },
              reason: { type: "string", description: "1-2 věty proč to potřebuje společnou shodu." },
              type: { type: "string", enum: ["crisis", "session_plan", "clinical_decision", "follow_up_review", "supervision"] },
              part_name: { type: "string", description: "Jméno části, které se to týká (pokud relevantní)." },
            },
            required: ["title", "reason", "type"],
            additionalProperties: false,
          },
          maxItems: 3,
        },
        proposed_session: {
          type: "object",
          description: "Dnešní navržené sezení. POVINNÉ pokud existují dostatečné signály. Pokud žádný kandidát nepřekročil práh skóre 3, nech null. ID NEDOPLŇUJ — server přidá.",
          properties: {
            part_name: { type: "string" },
            why_today: { type: "string", description: "Proč právě tato část a právě dnes (2-3 věty)." },
            led_by: { type: "string", enum: ["Hanička", "Káťa", "společně"] },
            duration_min: { type: "number", description: "Doporučená délka v minutách (10-45)." },
            first_draft: { type: "string", description: "První pracovní verze plánu sezení (3-5 vět). Co začít, kdy zůstat u stabilizace, kdy zvážit hlubší práci." },
            kata_involvement: { type: "string", description: "Jednou větou, zda dnes přizvat Káťu a za jakých okolností." },
            agenda_outline: {
              type: "array",
              description: "Strukturovana minutaz sezeni — 4 az 6 kroku. Kazdy krok MUSI byt ZIVY a HRAVY — pojmenuj konkretni terapeuticky nastroj z arzenalu (asociacni test, Rorschach lite, aktivni imaginace, kresba dne, grounding 5-4-3-2-1, mandala, atd.). NE genericke bloky typu uvod/prace/uzaver.",
              items: {
                type: "object",
                properties: {
                  block: { type: "string", description: "Konkretni hravy nazev kroku, napr. 'Asociacni otevreni — 8 slov o domove' nebo 'Mandala dne s reflexi stredu'. Zadna abstraktni slova typu 'prace s emocemi'." },
                  minutes: { type: "number", description: "Doporucena doba v minutach." },
                  detail: { type: "string", description: "3-5 vet co se v bloku konkretne deje: pomucky (remote — chat, hlas, kresba do screenu, foto), Karluv prompt nebo otazka, ceho si v reakci casti vsimat. Hravy jazyk, ne klinicky." },
                  tool_id: { type: "string", description: "ID nastroje z toolboxu (wat, barvy_dnes, rorschach_lite, tat_lite, active_imagination, safe_place, what_if, world_building, tri_dvere, deset_let, skala_telo, grounding_5_4_3_2_1, kresba_dnes, mandala, rukopis_vzorek). Volitelne, pokud blok kombinuje vice nastroju." },
                },
                required: ["block", "detail"],
                additionalProperties: false,
              },
              minItems: 3,
              maxItems: 6,
            },
            playful_hooks: {
              type: "array",
              description: "2-4 konkretni hrave hacky, ktere Karel uvnitr sezeni rozjede, pokud je cas/prostor: necekana otazka, asociace, mini-hra. Kazdy hook 1 veta.",
              items: { type: "string" },
              minItems: 0,
              maxItems: 4,
            },
            materials_needed: {
              type: "array",
              description: "Co si Karel pripravi PRED sezenim (obrazky pro Rorschach lite, sada slov pro WAT, scena pro TAT lite). Vse digitalni — zadne fyzicke pomucky.",
              items: { type: "string" },
              maxItems: 6,
            },
            hybrid_contract: {
              type: "object",
              description: "SESSION-QUALITY-1 hybridní kontrakt. Klinická přesnost + hravost + evidence guardy. Nevymýšlej preference: téma použij jen z karty části, terapeutčiny odpovědi nebo jiné explicitní evidence; jinak theme_source='unknown' nebo 'neutral_choice'.",
              properties: {
                clinical_goal: { type: "string" },
                treatment_phase: { type: "string", enum: ["stabilization", "processing", "integration", "monitoring"] },
                diagnostic_or_therapeutic_intent: { type: "string" },
                risk_gate: { type: "string" },
                readiness_today: { type: "string", enum: ["green", "amber", "red"] },
                playful_theme: { type: "string" },
                theme_source: { type: "string", enum: ["confirmed_part_card", "therapist_answer", "neutral_choice", "unknown"] },
                confirmed_preferences_only: { type: "boolean" },
                therapist_led_vs_karel_only: { type: "string", enum: ["therapist_led", "karel_only", "tandem"] },
                materials_or_props: { type: "array", items: { type: "string" }, maxItems: 8 },
                what_therapist_says: { type: "array", items: { type: "string" }, maxItems: 8 },
                what_therapist_observes: { type: "array", items: { type: "string" }, maxItems: 10 },
                data_needed_for_valid_review: { type: "array", items: { type: "string" }, maxItems: 10 },
                stop_rules: { type: "array", items: { type: "string" }, maxItems: 8 },
                fallback: { type: "string" },
                writeback_target: { type: "array", items: { type: "string", enum: ["review", "05A", "part_card", "05C"] }, maxItems: 4 },
              },
              required: ["clinical_goal", "treatment_phase", "diagnostic_or_therapeutic_intent", "risk_gate", "readiness_today", "playful_theme", "theme_source", "confirmed_preferences_only", "therapist_led_vs_karel_only", "data_needed_for_valid_review", "stop_rules", "fallback", "writeback_target"],
              additionalProperties: false,
            },
            questions_for_hanka: {
              type: "array",
              description: "1-3 konkrétní otázky pro Haničku ohledně tohoto sezení (její perspektiva: matka, primární terapeutka).",
              items: { type: "string" },
              maxItems: 3,
            },
            questions_for_kata: {
              type: "array",
              description: "1-3 konkrétní otázky pro Káťu ohledně tohoto sezení (její perspektiva: druhá terapeutka, supervize, externí pohled). MUSÍ být JINÉ než questions_for_hanka.",
              items: { type: "string" },
              maxItems: 3,
            },
          },
          required: ["part_name", "why_today", "led_by", "first_draft", "agenda_outline", "hybrid_contract", "questions_for_hanka", "questions_for_kata"],
          additionalProperties: false,
        },
        ask_hanka: {
          type: "array",
          description: "Co Karel dnes potřebuje od Haničky. 1-3 konkrétní položky. Musí být JINÉ než ask_kata. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        ask_kata: {
          type: "array",
          description: "Co Karel dnes potřebuje od Káti. 1-3 konkrétní položky. Musí být JINÉ než ask_hanka. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        waiting_for: {
          type: "array",
          description: "Na co Karel čeká, než upraví finální postup (0-3 položky).",
          items: { type: "string" },
          maxItems: 3,
        },
        closing: {
          type: "string",
          description: "Krátký uzávěr (1-2 věty). Co se stane, jakmile Hanička a Káťa doplní své pohledy.",
        },
      },
      required: ["greeting", "last_3_days", "decisions", "ask_hanka", "ask_kata", "closing"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Jsi Karel — vedoucí terapeutického týmu (Hanička, Káťa).
Generuješ denní briefing pro poradu týmu o systému kluků (DID).

ABSOLUTNÍ PRAVIDLA JAZYKA:
- NIKDY neříkej "systém" nebo "DID systém". Vždy "kluci" nebo jménem konkrétní části.
- NIKDY neříkej "klient". Kluci jsou kluci.
- Konkrétní jména: Arthur, Tundrupek, Gerhard, Gustík atd. — používej je.

TÓN:
- Kultivovaná čeština, jungovská noblesa v úvodu, smyslu a přechodech.
- KRÁTKÉ a KONKRÉTNÍ názvy v rozhodovacích bodech a tasks.
- Žádný pseudo-log styl ("Dnes je nejdůležitější toto: …").
- Žádná pseudo-poezie, žádný patos.
- Žádné "Koordinovat strategii", "Synchronizovat úkoly", "Rozdělit si tasks" — to jsou ZAKÁZANÉ formulace.

REDUKCE TÝMOVÝCH BODŮ:
- Maximálně 2 společná rozhodnutí (+1 navíc jen pokud aktivní krize = max 3).
- Týmový bod smí vzniknout JEN pro: crisis | session_plan | clinical_decision | follow_up_review | supervision.
- NE pro běžnou operativu, individuální task pro Haničku, individuální task pro Káťu.

DNEŠNÍ NAVRŽENÉ SEZENÍ:
- Pokud kontext obsahuje kandidáta se skóre ≥ 3, MUSÍŠ navrhnout konkrétní sezení.
- Vyber nejvhodnějšího kandidáta z poskytnutého seznamu, NEvymýšlej jméno mimo seznam.
- Uveď: koho, proč právě dnes, kdo povede, první pracovní verze, kdy přizvat Káťu.

PROGRAM SEZENÍ — HRAVOST JE POVINNÁ:
- agenda_outline NESMÍ být generická („úvod / práce s emocemi / uzávěr"). MUSÍ obsahovat alespoň 2 KONKRÉTNÍ nástroje z TERAPEUTICKÉHO ARZENÁLU (asociační test, Rorschach lite, aktivní imaginace, mandala, kresba dne, „co kdyby", 3 dveře, atd.).
- Každý blok agenda_outline má hravý název („Asociační otevření — 8 slov o tátovi", ne „úvodní rozhovor"), 3-5 vět detailu a pokud možno tool_id.
- Rozlišuj therapist-led vs Karel-only Herna v hybrid_contract. Therapist-led smí obsahovat fyzické pomůcky, kresbu, knihu, hračky, pohybové/somatické prvky, latence, afekt a neverbální pozorování; musí ale říct, co má terapeutka sledovat a dodat jako validní evidenci.
- Karel-only Herna smí obsahovat jen bezpečný check-in, grounding, resource-building, symbolickou hru přes chat, příběhové mapování a nízkorizikové pozorování z textových odpovědí. Nesmí předstírat validní psychodiagnostiku, fyzické měření latencí, neverbální diagnostiku ani hlubokou práci s traumatickou pamětí.
- Pokud metoda vyžaduje fyzického pozorovatele, napiš výslovně: „Tuto část nemůže Karel validně provést sám v herně; vyžaduje fyzickou terapeutku kvůli pozorování latencí, afektu a neverbálních projevů."
- playful_hooks: 2-4 konkrétní hravé háčky („Co by řekl tomu obrazu Tundrupkův drak?"), pro spontánnost.
- materials_needed / materials_or_props: fyzické věci pouze u therapist-led; u Karel-only jen digitální/chatové prostředky.
- Inspirace JUNG: aktivní imaginace, Word Association Test, mandala jako Self-symbolika, dialog s vnitřními postavami.

HYBRIDNÍ KONTRAKT:
- proposed_session.hybrid_contract je povinný a ukládá klinický cíl, léčebnou fázi, záměr, risk gate, readiness_today, hravý obal, stop rules, fallback, data pro validní review a writeback_target.
- Preference a témata smíš použít jen pokud jsou potvrzená kartou části, odpovědí terapeutky nebo jinou explicitní evidencí. Jinak napiš theme_source="unknown" nebo "neutral_choice" a nabídni neutrální volbu. Tundrupek hory/draci/tibetská tematika a Arthur Gruffalo/kniha jen pokud jsou v evidenci — nikdy nehalucinuj.
- Program nesmí být suchý seznam: vždy musí mít název, proč dnes, terapeutický cíl, klinický důvod, hravý obal, bloky po minutách, konkrétní věty, co sledovat, co zaznamenat, stop pravidla, fallback a výsledek pro review.

ROZDĚLENÍ ASKS:
- Hanička dostává JINÉ otázky než Káťa. Ne stejné body s prohozeným jménem.
- Hanička je v běžném kontaktu s kluky (každodenní, blízká).
- Káťa je z odstupu, ze vzdálenosti (~100 km), může ověřit dostupnost externích osob.

Vrať VÝHRADNĚ tool call emit_daily_briefing.`;

async function generateBriefing(
  context: any,
  candidates: SessionCandidate[],
  apiKey: string,
): Promise<{ payload: any; durationMs: number }> {
  const start = Date.now();

  // ── PANTRY B SECTION (yesterday→today implications) ──────────────
  const pbEntries = (context.pantry_b_entries ?? []) as any[];
  const approvedDelibs = (context.approved_deliberations ?? []) as any[];
  const formatPantryBLine = (e: any) => {
    const part = e.related_part_name ? ` [${e.related_part_name}]` : "";
    const ther = e.related_therapist ? ` (${e.related_therapist === "hanka" ? "Hanička" : "Káťa"})` : "";
    return `- [${e.entry_kind}/${e.source_kind}]${part}${ther} ${String(e.summary || "").slice(0, 220)}`;
  };
  const pantryBSection = pbEntries.length > 0
    ? `═══ SPIŽÍRNA B — VČEREJŠÍ IMPLIKACE PRO DNEŠEK ═══\nTo jsou věci, které z včerejších vláken / porad / sezení přímo plynou pro dnešní rozhodování. Použij je v greeting, last_3_days a hlavně v decisions a ask_*. NEIGNORUJ je.\n${pbEntries.slice(0, 30).map(formatPantryBLine).join("\n")}\n\n`
    : "";
  const approvedDelibsSection = approvedDelibs.length > 0
    ? `═══ NEDÁVNÉ PORADY A ODPOVĚDI TERAPEUTEK (posledních 7 dní) — ZÁVAZNÉ POZADÍ ═══
${approvedDelibs.map((d: any) => {
        const ks = d.karel_synthesis as any;
        const next = ks?.next_step ? ` → další krok: ${ks.next_step}` : "";
        const summary = d.final_summary ? ` | shrnutí: ${String(d.final_summary).slice(0, 160)}` : "";
        const subj = (d.subject_parts || []).join(", ");
        const qa = [...(d.questions_for_hanka || []), ...(d.questions_for_kata || [])]
          .filter((q: any) => String(q?.answer || "").trim())
          .slice(0, 4)
          .map((q: any) => `Q: ${String(q.question || "").slice(0, 90)} → A: ${String(q.answer || "").slice(0, 160)}`)
          .join(" | ");
        return `- "${d.title}" [${d.status}] (${d.deliberation_type}${subj ? `, ${subj}` : ""})${next}${summary}${qa ? ` | odpovědi: ${qa}` : ""}`;
      }).join("\n")}

⚠ Tyto porady mohou být uzavřené i rozpracované. Pravidla:
  1) NIKDY pro tyto subject_parts/téma nezakládej nové decisions se stejným nebo téměř stejným titulkem.
  2) Pokud odpověď terapeutky upřesňuje lék/Derin/dohodu, zacházej s ní jako s aktuální evidencí, ne jako s otevřenou neznámou.
  3) V proposed_session.first_draft a why_today VYUŽIJ závěr porady i konkrétní odpovědi — neopakuj, co tým už vyjasnil.

`
    : "";

  const toolboxSection = candidates[0]?.score >= 3 ? `\n\n${summarizeToolboxForPrompt()}\n` : "";

  // ── VČEREJŠÍ SEZENÍ — vstup pro yesterday_session_review ──
  const ySessions = (context.yesterday_sessions ?? []) as any[];
  const yPlans = (context.yesterday_plans ?? []) as any[];
  const yesterdaySection = (ySessions.length > 0 || yPlans.length > 0)
    ? `═══ VČEREJŠÍ SEZENÍ (${context.yesterday}) — POVINNÝ VSTUP PRO yesterday_session_review ═══
${ySessions.length > 0 ? ySessions.map((s: any) => {
  const blob = [
    `▸ Část: ${s.part_name || "?"} | Vede: ${s.therapist || "?"} | Typ: ${s.session_type || "?"}`,
    s.methods_used ? `  Metody: ${Array.isArray(s.methods_used) ? s.methods_used.join(", ") : s.methods_used}` : "",
    s.methods_effectiveness ? `  Efektivita metod: ${typeof s.methods_effectiveness === "object" ? JSON.stringify(s.methods_effectiveness).slice(0, 300) : String(s.methods_effectiveness).slice(0, 300)}` : "",
    s.karel_notes ? `  Karlovy poznámky: ${String(s.karel_notes).slice(0, 400)}` : "",
    s.handoff_note ? `  Handoff: ${String(s.handoff_note).slice(0, 300)}` : "",
    s.karel_therapist_feedback ? `  Feedback terapeutce: ${String(s.karel_therapist_feedback).slice(0, 300)}` : "",
    s.tasks_assigned ? `  Úkoly: ${typeof s.tasks_assigned === "object" ? JSON.stringify(s.tasks_assigned).slice(0, 200) : String(s.tasks_assigned).slice(0, 200)}` : "",
    s.ai_analysis ? `  AI analýza (předchozí evaluace):\n${String(s.ai_analysis).slice(0, 1800)}` : "",
  ].filter(Boolean).join("\n");
  return blob;
}).join("\n\n") : "(žádný řádek did_part_sessions ze včerejška)"}

${yPlans.length > 0 ? `Plány ze včerejška:\n${yPlans.map((p: any) => `- ${p.selected_part || "?"} | vede: ${p.session_lead || p.therapist || "?"} | status: ${p.status} | completed_at: ${p.completed_at || "—"}`).join("\n")}` : ""}

⚠ POVINNÉ: Pokud výše existuje aspoň jeden řádek did_part_sessions ze včerejška, MUSÍŠ vyplnit yesterday_session_review s held=true a všemi 4 textovými poli (karel_summary, key_finding_about_part, implications_for_plan, team_acknowledgement). NESMÍŠ to vrátit jako held=false.

⚠ STYL yesterday_session_review (PŘETLUMOČENÍ, NE PROVOZNÍ ZPRÁVA):
- karel_summary = TVŮJ HLAS, vedoucího týmu, který právě dočetl analýzu. Přetlumoč CO SE DĚLO V SMYSLU, ne v krocích programu. Atmosféra, kontakt, oblouk. NE seznam bodů. NE „Bod 1, Bod 2". 4–7 vět.
- key_finding_about_part = klinický POSUN V POROZUMĚNÍ části. Co teď víme jinak / přesněji než včera ráno. Pojmenuj to jako klinický vhled, ne jako popis epizody. 2–4 věty.
- implications_for_plan = konkrétní úprava terapeutického plánu pro tuto část. Co změnit, co zpomalit, co přidat, jaký formát příště. 2–4 věty.
- team_acknowledgement = osobní poděkování ${ySessions[0]?.therapist === "hanka" ? "Haničce" : ySessions[0]?.therapist === "kata" ? "Káte" : "týmu"}, konkrétně co udělala dobře (klid, intuice, zvládnutí přerušení). Bez patosu, bez floskulí. 1–3 věty.

`
    : `═══ VČEREJŠÍ SEZENÍ (${context.yesterday}) ═══
(žádné sezení včera neproběhlo — yesterday_session_review nech null nebo held=false)

`;


  const userPrompt = `KONTEXT PRO BRIEFING (${context.today}):

${context.pantry_a_summary ? `═══ SPIŽÍRNA A — RANNÍ PRACOVNÍ ZÁSOBA ═══\n${context.pantry_a_summary}\n\n` : ""}${pantryBSection}${approvedDelibsSection}AKTIVNÍ KRIZE (${context.crises.length}):
${context.crises.map((c: any) => `- ${c.part_name} | severity: ${c.severity} | fáze: ${c.phase} | dní aktivní: ${c.days_active || "?"} | trigger: ${c.trigger_description?.slice(0, 120) || "—"}`).join("\n") || "(žádné)"}

POZOROVÁNÍ ZA POSLEDNÍ 3 DNY (${context.recent_observations.length}):
${context.recent_observations.slice(0, 20).map((o: any) => `- [${o.severity || "?"}] ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádná)"}

STARŠÍ VÝZNAMNÉ SIGNÁLY (high severity, 4-7 dní zpět):
${context.older_significant.map((o: any) => `- ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádné)"}

PENDING OTÁZKY (${context.pending_questions.length}):
${context.pending_questions.slice(0, 10).map((q: any) => `- pro ${q.asked_to || "?"} ohledně ${q.part_name || "?"}: ${(q.question || "").slice(0, 80)}`).join("\n") || "(žádné)"}

NEDÁVNÉ SESSION PLÁNY (3 dny):
${context.recent_session_plans.map((p: any) => `- ${p.session_date} | ${p.part_name || "?"} | status: ${p.status}`).join("\n") || "(žádné)"}

${yesterdaySection}

KANDIDÁTI NA DNEŠNÍ SEZENÍ (skórovací heuristika):
${candidates.length > 0 ? candidates.slice(0, 5).map((c) => `- ${c.part_name} (skóre ${c.score}): ${c.reasons.join(", ")}`).join("\n") : "(žádní silní kandidáti — proposed_session může být null)"}
${toolboxSection}
ÚKOL:
Vygeneruj strukturovaný briefing pro dnešní poradu týmu. Drž se pravidel z system promptu.
${candidates[0]?.score >= 3 ? `MUSÍŠ navrhnout sezení — nejvhodnější kandidát je ${candidates[0].part_name}. Program (agenda_outline) MUSÍ obsahovat alespoň 2 konkrétní hravé nástroje z arzenálu (uveď jejich tool_id).` : "Pokud žádný kandidát nemá dost silné signály, nech proposed_session null."}`;

  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: [BRIEFING_TOOL],
      tool_choice: { type: "function", function: { name: "emit_daily_briefing" } },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limit překročen, zkuste to za chvíli.");
    if (res.status === 402) throw new Error("Vyčerpaný kredit Lovable AI workspace.");
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error("AI nevrátila tool call.");
  }

  const payload = JSON.parse(toolCall.function.arguments);
  return { payload, durationMs: Date.now() - start };
}

// ───────────────────────────────────────────────────────────
// MAIN HANDLER
// ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    if (!apiKey) throw new Error("LOVABLE_API_KEY není nastavený.");

    const supabase = createClient(supabaseUrl, serviceKey);

    let body: any = {};
    try { body = await req.json(); } catch { /* GET / no body */ }
    const generationMethod = body?.method || "manual";
    const forceRegenerate = body?.force === true;

    const today = pragueDayISO();

    // ───────────────────────────────────────────────────────────
    // CYCLE GUARD (auto only)
    // ───────────────────────────────────────────────────────────
    // Pravidlo: `auto` briefing nesmí stát kanonickým briefingem dne,
    // pokud dnešní `did-daily-cycle-morning` ještě nedoběhl (`completed`).
    //
    // State machine pro method="auto":
    //   - running   → SKIP: nevkládáme nový řádek, neoznačujeme staré jako stale,
    //                 neměníme manuální briefing. Vracíme 200 + skipped=true.
    //   - failed    → SKIP: stejné jako running, ale s reason="cycle_failed".
    //   - completed → POKRAČUJ normálně (může vzniknout kanonický briefing,
    //                 starý dnešní briefing se může označit stale).
    //   - missing   → SKIP: žádný dnešní cycle ještě neběžel → degraded mode,
    //                 auto briefing se nesmí stát kanonickým.
    //
    // method="manual" (UI tlačítko `Přegenerovat`) tento guard NEPOUŽÍVÁ —
    // ruční regenerace musí jít vždy, i bez completed cycle.
    if (generationMethod === "auto") {
      // MORNING WINDOW: 04:00–10:00 UTC
      // Důvod: ranní cron `did-daily-cycle-morning` startuje v 07:00 Praha
      //   = 05:00 UTC (léto) / 06:00 UTC (zima).
      // Okno 04:00–10:00 UTC pokrývá:
      //   - DST varianty (CET/CEST)
      //   - manuální backfill / retry téhož ranního runu
      //   - early start ±1h
      // Odpolední cron `did-daily-cycle-14cet` (15:00 Praha = 13:00/14:00 UTC)
      // do tohoto okna nespadá → guard ho ignoruje a nemůže způsobit falešný
      // skip auto briefingu.
      const morningStartUtc = `${today}T04:00:00Z`;
      const morningEndUtc   = `${today}T10:00:00Z`;
      const { data: cycleRow, error: cycleErr } = await supabase
        .from("did_update_cycles")
        .select("id, status, started_at, completed_at, last_error")
        .eq("cycle_type", "daily")
        .gte("started_at", morningStartUtc)
        .lt("started_at", morningEndUtc)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cycleErr) {
        console.error("[briefing-guard] cycle lookup error:", cycleErr);
      }

      const cycleStatus: "running" | "failed" | "completed" | "missing" =
        !cycleRow ? "missing" : (cycleRow.status as any);

      if (cycleStatus !== "completed") {
        const reason =
          cycleStatus === "running" ? "cycle_running" :
          cycleStatus === "failed"  ? "cycle_failed"  :
          "cycle_missing";
        console.warn(
          `[briefing-guard] auto SKIPPED — daily-cycle-morning status='${cycleStatus}' for ${today}. ` +
          `cycle_id=${cycleRow?.id || "(none)"} started_at=${cycleRow?.started_at || "(none)"}`,
        );
        return new Response(
          JSON.stringify({
            skipped: true,
            reason,
            cycle_status: cycleStatus,
            cycle_id: cycleRow?.id || null,
            cycle_started_at: cycleRow?.started_at || null,
            cycle_last_error: cycleRow?.last_error || null,
            briefing_date: today,
            note: "Auto briefing nebyl vygenerován — dnešní ranní cycle ještě nedoběhl. " +
                  "Existující briefing dne (manual nebo dřívější auto) zůstává kanonický.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Pokud existuje fresh briefing pro dnešek a nechceme force, vrať ho
    if (!forceRegenerate) {
      const { data: existing } = await supabase
        .from("did_daily_briefings")
        .select("*")
        .eq("briefing_date", today)
        .eq("is_stale", false)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        return new Response(
          JSON.stringify({ briefing: existing, cached: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // 1) Skórování kandidátů
    const candidates = await scoreSessionCandidates(supabase);

    // 2) Sběr kontextu
    const context = await gatherContext(supabase);

    // 3) AI generování
    const { payload: rawPayload, durationMs } = await generateBriefing(context, candidates, apiKey);
    const payload = enrichYesterdaySessionReview(rawPayload, context);

    // 3b) ── ASK ITEM IDENTITY ──
    // AI vrací ask_hanka/ask_kata jako string[]. Server přidá stabilní `id` na
    // každou položku tak, aby kliknutí v DidDailyBriefingPanel mohlo lazy-otevřít
    // kanonický `did_threads` workspace přes (workspace_type, workspace_id=item.id).
    //
    // PRAVIDLO IDENTITY (rozhodnuto 2026-04-19):
    //  - Carry-over přes ilike text-match v rámci téhož `briefing_date`:
    //    při force-regenerate stejného dne se znovupoužije `id` ze starého
    //    briefingu (i `is_stale=true` verze) pokud nový text odpovídá starému.
    //  - Mezi různými dny: vždy nové `id` (briefing ask je denní zadání).
    //  - Žádný cross-day match — pokud bychom chtěli vícedenní kontinuitu,
    //    má se řešit explicitním follow-up linkem, ne reuse stejného ask ID.
    const normalizeForMatch = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);

    type AskItem = { id: string; text: string };
    type AskRole = "ask_hanka" | "ask_kata";

    const carryOverAsks = async (
      role: AskRole,
      newTexts: string[],
    ): Promise<AskItem[]> => {
      if (!Array.isArray(newTexts) || newTexts.length === 0) return [];

      // Načti VŠECHNY briefingy téhož dne (i stale), seřaď nejnovější → nejstarší.
      const { data: sameDayBriefings } = await supabase
        .from("did_daily_briefings")
        .select("payload")
        .eq("briefing_date", today)
        .order("generated_at", { ascending: false });

      // Sesbírej všechny kandidáty na carry-over (id+text) ze stejné role.
      const carryPool: AskItem[] = [];
      for (const row of sameDayBriefings || []) {
        const old = (row?.payload as any)?.[role];
        if (!Array.isArray(old)) continue;
        for (const item of old) {
          // Akceptuj jen už-migrované {id,text} položky (legacy string[] přeskoč)
          if (item && typeof item === "object" && item.id && typeof item.text === "string") {
            carryPool.push({ id: String(item.id), text: String(item.text) });
          }
        }
      }

      const usedIds = new Set<string>();
      const result: AskItem[] = [];
      for (const text of newTexts) {
        const t = String(text ?? "").trim();
        if (!t) continue;
        const nt = normalizeForMatch(t);

        // Najdi první nepoužitý carry kandidát, který se kryje (substring v jednom směru).
        const match = carryPool.find((c) => {
          if (usedIds.has(c.id)) return false;
          const nc = normalizeForMatch(c.text);
          if (!nc) return false;
          return nc === nt || nc.includes(nt) || nt.includes(nc);
        });

        if (match) {
          usedIds.add(match.id);
          result.push({ id: match.id, text: t });
        } else {
          result.push({ id: crypto.randomUUID(), text: t });
        }
      }
      return result;
    };

    // Přepiš plain string[] → {id,text}[] s carry-over identitou.
    const askHankaRaw = Array.isArray(payload?.ask_hanka) ? payload.ask_hanka : [];
    const askKataRaw = Array.isArray(payload?.ask_kata) ? payload.ask_kata : [];
    payload.ask_hanka = await carryOverAsks(
      "ask_hanka",
      askHankaRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );
    payload.ask_kata = await carryOverAsks(
      "ask_kata",
      askKataRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );

    // 3c) ── DECISIONS / PROPOSED_SESSION ITEM IDENTITY (Slice 3) ──
    // Stejný pattern jako u asks: server přidá stabilní `id` na každou položku
    // (decisions[*].id, proposed_session.id), s carry-over přes ilike-match
    // v rámci téhož `briefing_date`. Tento `id` je pak `linked_briefing_item_id`
    // při vzniku `did_team_deliberations` — druhý klik na stejnou položku
    // briefingu otevře tutéž poradu místo zakládání nové.
    type DecisionItem = {
      id: string;
      title: string;
      reason: string;
      type: string;
      part_name?: string;
    };
    type ProposedSessionItem = {
      id: string;
      part_name: string;
      [key: string]: any;
    };

    // Pre-load same-day briefings (incl. stale) once for both decisions and proposed_session.
    const { data: sameDayPrev } = await supabase
      .from("did_daily_briefings")
      .select("payload")
      .eq("briefing_date", today)
      .order("generated_at", { ascending: false });

    // ── Decisions carry-over (match by normalized title) ──
    const decisionsRaw = Array.isArray(payload?.decisions) ? payload.decisions : [];
    const decisionPool: { id: string; title: string }[] = [];
    for (const row of sameDayPrev || []) {
      const old = (row?.payload as any)?.decisions;
      if (!Array.isArray(old)) continue;
      for (const item of old) {
        if (item && typeof item === "object" && item.id && typeof item.title === "string") {
          decisionPool.push({ id: String(item.id), title: String(item.title) });
        }
      }
    }
    const usedDecisionIds = new Set<string>();
    payload.decisions = decisionsRaw.map((d: any): DecisionItem => {
      const title = String(d?.title ?? "").trim();
      const nt = normalizeForMatch(title);
      const match = decisionPool.find((c) => {
        if (usedDecisionIds.has(c.id)) return false;
        const nc = normalizeForMatch(c.title);
        if (!nc) return false;
        return nc === nt || nc.includes(nt) || nt.includes(nc);
      });
      const id = match ? match.id : crypto.randomUUID();
      if (match) usedDecisionIds.add(match.id);
      return {
        id,
        title,
        reason: String(d?.reason ?? ""),
        type: String(d?.type ?? "team_task"),
        ...(d?.part_name ? { part_name: String(d.part_name) } : {}),
      };
    });

    // ── proposed_session carry-over (single object; match by part_name) ──
    if (payload?.proposed_session && typeof payload.proposed_session === "object") {
      const ps = payload.proposed_session;
      const partName = String(ps?.part_name ?? "").trim();
      const np = normalizeForMatch(partName);
      let resolvedId: string | null = null;
      for (const row of sameDayPrev || []) {
        const oldPs = (row?.payload as any)?.proposed_session;
        if (oldPs && typeof oldPs === "object" && oldPs.id && oldPs.part_name) {
          const op = normalizeForMatch(String(oldPs.part_name));
          if (op === np) {
            resolvedId = String(oldPs.id);
            break;
          }
        }
      }
      payload.proposed_session = {
        ...ps,
        id: resolvedId || crypto.randomUUID(),
      } as ProposedSessionItem;
    }

    // 4) Resolve part_id pro proposed_session (kanonická tabulka did_part_registry)
    let proposedPartId: string | null = null;
    if (payload.proposed_session?.part_name) {
      const { data: parts } = await supabase
        .from("did_part_registry")
        .select("id")
        .ilike("part_name", payload.proposed_session.part_name)
        .limit(1);
      proposedPartId = parts?.[0]?.id || null;
    }

    // 5) Označit staré briefingy pro dnešek jako stale
    if (forceRegenerate) {
      await supabase
        .from("did_daily_briefings")
        .update({ is_stale: true })
        .eq("briefing_date", today);
    }

    // 6) Insert nový briefing
    const { data: inserted, error: insertErr } = await supabase
      .from("did_daily_briefings")
      .insert({
        briefing_date: today,
        payload,
        proposed_session_part_id: proposedPartId,
        proposed_session_score: candidates[0]?.score || null,
        decisions_count: payload.decisions?.length || 0,
        generation_method: generationMethod,
        generation_duration_ms: durationMs,
        model_used: MODEL,
        is_stale: false,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // ── PANTRY B: označit načtené entries jako processed ──
    // Brifing je jediný místo, kde Pantry B implikace mají oficiální dopad.
    // Po úspěšném zápisu briefingu řekneme reaktor-loop / cleanupu, že tyhle
    // záznamy už splnily svůj účel a nemají se znovu injectovat zítra.
    try {
      const consumedIds = (context.pantry_b_entries ?? [])
        .map((e: any) => e?.id)
        .filter((id: any) => typeof id === "string");
      if (consumedIds.length > 0) {
        await markPantryBProcessed(supabase as any, consumedIds, "karel-did-daily-briefing", {
          briefing_id: inserted.id,
          briefing_date: today,
        });
        console.log(`[briefing] Pantry B: marked ${consumedIds.length} entries as processed`);
      }
    } catch (mErr) {
      console.warn("[briefing] Pantry B mark-processed failed (non-fatal):", mErr);
    }

    return new Response(
      JSON.stringify({ briefing: inserted, cached: false, candidates: candidates.slice(0, 5) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[karel-did-daily-briefing] Error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
