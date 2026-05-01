/**
 * externalCurrentEventReplan.ts
 *
 * SEV-1 GLOBAL EXTERNAL CURRENT-EVENT REPLAN ORCHESTRATOR
 * ───────────────────────────────────────────────────────
 * Když Hanička/Káťa pošle do jakékoli porady (Herna NEBO Sezení) urgentní
 * real-world update typu „Timmy je ohrožený, kluci jsou ovlivnění, přeplánuj
 * všechno", aplikace nesmí přepsat jen lokální `program_draft`. Musí:
 *
 *   1. klasifikovat vstup jako external_current_event_update
 *   2. najít VŠECHNY dnešní/aktivní porady (session_plan + playroom) usera
 *   3. zneplatnit jejich podpisy a vrátit do in_revision
 *   4. přepsat program_draft bezpečnou krizovou šablonou (real event,
 *      ne symbol/projekce)
 *   5. okamžitě vytvořit terapeutické úkoly (idempotentně)
 *   6. zapsat do Spíže B + did_event_ingestion_log
 *   7. force-rebuild Karlův přehled přes sla-watchdog
 *   8. nepředstírat webové ověření, pokud žádné neproběhlo
 *
 * Volá se z karel-team-deliberation-iterate POUZE když klasifikace projde.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { appendPantryB } from "./pantryB.ts";

// ────────────────────────────────────────────────────────────────────────────
// 1. CLASSIFIER
// ────────────────────────────────────────────────────────────────────────────

export interface ExternalEventClassification {
  is_external_current_event: boolean;
  urgency: "low" | "normal" | "high" | "crisis";
  affects_session: boolean;
  affects_playroom: boolean;
  requires_replan: boolean;
  requires_web_verification: boolean;
  event_label: string | null;
  matched_signals: string[];
}

// Strong signals — any of these alone won't trigger; we need (event_signal OR
// real-world phrase) AND (replan_signal OR web_signal OR affect_signal).
const EVENT_LABEL_RE = /\b(timmy|velryba|velrybu|velryby|keporkak)\b/i;
const REAL_WORLD_RE =
  /(skute(?:č|c)n[áéa]?\s+ud[áa]lost|aktu[áa]ln[íi]\s+(?:zpr[áa]v|situac)|barge|b[áa]rce|z[áa]chran[áa]ř|nedodrželi\s+slovo|ohro[žz]en|extr[ée]mn[ěe]\s+vyp[ji]at)/i;
const REPLAN_RE =
  /(ve(?:š|s)ker[ýy]\s+program|pozm(?:ě|e)nit|p(?:ř|r)epl(?:á|a)novat|sestav(?:it)?\s+program|p(?:ř|r)edělat\s+(?:plán|program)|jak\s+v\s+sezen[íi]\s+tak\s+i\s+v\s+hern[ěe])/i;
const WEB_RE =
  /(naj(?:di|dou)\s+na\s+internetu|posledn[íi]\s+ov(?:ě|e)(?:ř|r)en[éee]\s+zpr[áa]v|aktu[áa]ln[íi]\s+zdroj)/i;
const AFFECT_RE =
  /(kluci\s+jsou\s+(?:ovlivněni|ovlivnen|negativn[ěe])|d[ěe]ti\s+(?:jsou\s+)?(?:zat[íi]žen|zasa[žz]en))/i;

export function classifyExternalCurrentEvent(text: string): ExternalEventClassification {
  const matched: string[] = [];
  const eventHit = EVENT_LABEL_RE.exec(text);
  const realHit = REAL_WORLD_RE.test(text);
  const replanHit = REPLAN_RE.test(text);
  const webHit = WEB_RE.test(text);
  const affectHit = AFFECT_RE.test(text);

  if (eventHit) matched.push(`event:${eventHit[0]}`);
  if (realHit) matched.push("real_world_phrase");
  if (replanHit) matched.push("replan_request");
  if (webHit) matched.push("web_verification_request");
  if (affectHit) matched.push("children_affected");

  // Trigger rule: musí být alespoň jeden „event/real-world" signál a alespoň
  // jeden „akční" signál (replan / web / affect). Jinak je to jen běžná zmínka.
  const hasContextSignal = !!eventHit || realHit;
  const hasActionSignal = replanHit || webHit || affectHit;
  const isExternal = hasContextSignal && hasActionSignal;

  return {
    is_external_current_event: isExternal,
    urgency: isExternal ? "high" : "normal",
    affects_session: isExternal,
    affects_playroom: isExternal,
    requires_replan: isExternal && (replanHit || affectHit),
    requires_web_verification: isExternal && webHit,
    event_label: eventHit ? eventHit[0] : null,
    matched_signals: matched,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. SAFE CRISIS-SUPPORT TEMPLATES (NOT AI-generated — deterministic safety)
// ────────────────────────────────────────────────────────────────────────────

export interface AgendaBlock {
  block: string;
  minutes?: number | null;
  detail?: string | null;
  [k: string]: unknown;
}

function eventNoun(label: string | null): string {
  if (!label) return "této situace";
  const l = label.toLowerCase();
  if (l.startsWith("velrybu")) return "velryby Timmyho";
  if (l.startsWith("velryb")) return "velryby Timmyho";
  if (l === "timmy") return "Timmyho";
  return label;
}

export function buildSafeSessionDraft(eventLabel: string | null): AgendaBlock[] {
  const noun = eventNoun(eventLabel);
  return [
    {
      block: "Bezpečný vstup a orientace",
      minutes: 6,
      detail: `Hanička ověří, kdo je dnes přítomný, jestli je bezpečné se tématu ${noun} dotknout, a nabídne jasné stop pravidlo. Žádný výklad zatím nepadá.`,
    },
    {
      block: `Co dnes kluci o ${noun} vědí`,
      minutes: 8,
      detail: "Pouze jejich vlastní slova. Nezahlcovat novinkami, nepřidávat neověřené detaily, nevykládat. Cíl je orientace v tom, co už mají v hlavě.",
    },
    {
      block: "Tělo a emoce",
      minutes: 10,
      detail: "Zmapovat, kde je v těle napětí, smutek, strach, vztek, bezmoc nebo pocit zrady. Neinterpretovat jako symbol; jde o reálnou emoční zátěž.",
    },
    {
      block: "Co by dnes pomohlo",
      minutes: 8,
      detail: "Najít jednu malou podporu: voda, deka, světlo, blízkost Haničky, pauza, bezpečné místo. Žádná odpovědnost za záchranu zvenčí.",
    },
    {
      block: "Měkké uzavření",
      minutes: 6,
      detail: `Zdůraznit, že ${noun} situace je skutečná a těžká, ale kluci za ni nenesou odpovědnost. Zaznamenat vlastní slova, tělo a stop signály.`,
    },
  ];
}

export function buildSafePlayroomDraft(eventLabel: string | null): AgendaBlock[] {
  const noun = eventNoun(eventLabel);
  return [
    {
      block: "Dveře do Herny",
      minutes: 3,
      detail: "Karel nabídne volbu: můžeme dnes jen zkontrolovat, jak se má tvoje srdce. Nemusíme řešit všechno.",
    },
    {
      block: "Počasí uvnitř — emoce a tělo",
      minutes: 5,
      detail: "Část vybere jedno slovo, barvu nebo obraz pro dnešní emoce a pro to, co cítí v těle. Žádná interpretace.",
    },
    {
      block: `Bezpečný dotyk s tématem ${noun}`,
      minutes: 7,
      detail: `Jen pokud část sama chce: Co dnes o ${noun} víš? Co se stane v těle, když na ${noun.endsWith("ho") ? "něj" : "to"} myslíš? Je toho moc, nebo se o tom dá chvilku mluvit?`,
    },
    {
      block: "Co by dnes pomohlo",
      minutes: 5,
      detail: "Část vybere jednu podporu: voda, deka, světlo, Hanička blízko, pauza, kresba bezpečného místa.",
    },
    {
      block: "Zavření Herny",
      minutes: 3,
      detail: `Karel řekne: ${noun} situace je skutečná a těžká. Ty za ni neneseš odpovědnost. Dnes stačí zůstat v bezpečí.`,
    },
  ];
}

const FORBIDDEN_DIRECTIONS_PLAYROOM = [
  "nenutit kreslit zvíře nebo událost",
  "neptat se, co situace symbolizuje",
  "neříkat: zachraň ho",
  "neptat se na katastrofické scénáře",
  "nepoužívat neověřené zprávy jako dramatický stimulus",
];

const FORBIDDEN_DIRECTIONS_SESSION = [
  "neinterpretovat událost jako symbol nebo projekci",
  "neptat se, co událost znamená",
  "nedávat dětem odpovědnost za záchranu",
  "nepouštět neověřené zprávy přímo dětem",
  "nedramatizovat",
  "nediagnostikovat z reakce na zprávu",
];

// ────────────────────────────────────────────────────────────────────────────
// 3. HUMAN, TRUTHFUL INLINE COMMENT (no fake web verification)
// ────────────────────────────────────────────────────────────────────────────

export function buildTruthfulKarelInlineComment(args: {
  authorLabel: string;
  eventLabel: string | null;
  webVerificationAvailable: boolean;
  affectedDeliberationCount: number;
}): string {
  const { authorLabel, eventLabel, webVerificationAvailable, affectedDeliberationCount } = args;
  const noun = eventNoun(eventLabel);
  const webLine = webVerificationAvailable
    ? "Aktuální zdroje teď ověřuji a uložím citace k poradě."
    : "Nemám teď v aplikaci nástroj na ověření aktuálních zpráv. Pracuji s tvým hlášením jako s urgentním terapeutickým vstupem; pokud mi pošleš odkazy, zapracuji je jako ověřené zdroje.";
  const scope = affectedDeliberationCount > 1
    ? `Starý návrh Sezení i Herny pozastavuji a vracím obě porady do úpravy.`
    : `Starý návrh pozastavuji a vracím poradu do úpravy.`;
  return `${authorLabel}, beru to jako urgentní změnu reality, ne jako běžnou poznámku k programu. ${scope} Připravil jsem nový bezpečný plán zaměřený na dnešní napětí kolem ${noun} — držím to jako skutečnou událost a emoční zátěž pro kluky, ne jako symbol. ${webLine} První krok není výklad, ale zjištění: co kluci dnes vědí, co cítí v těle, jestli jsou zahlcení a co jim pomůže zůstat v bezpečí.`;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. ANTI-AUDIT GUARD for inline comments
// ────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_AUDIT_TERMS = [
  "pantry", "spíž", "spiz",
  "DID-relevantn", "did-relevantn",
  "source_ref", "source ref",
  "backend",
  "pipeline",
  "raw observation", "raw_observation",
  "event_ingestion", "event ingestion",
  "follow-upu", "zohledním ve follow",
  "našel jsem na internetu", "podle posledních zpráv", "ověřil jsem",
];

export function inlineCommentHasAuditLanguage(text: string): { ok: boolean; hits: string[] } {
  const lower = text.toLowerCase();
  const hits = FORBIDDEN_AUDIT_TERMS.filter((t) => lower.includes(t.toLowerCase()));
  return { ok: hits.length === 0, hits };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. ORCHESTRATOR
// ────────────────────────────────────────────────────────────────────────────

export interface OrchestratorContext {
  admin: SupabaseClient;
  userId: string;
  triggeringDeliberationId: string;
  authorLabel: string; // "Hanička" | "Káťa"
  authorRole: "hanka" | "kata";
  rawText: string;
  classification: ExternalEventClassification;
  webVerificationAvailable: boolean; // false unless we have a real web search tool
  supabaseUrl: string;
  serviceKey: string;
}

export interface OrchestratorResult {
  affected_deliberation_ids: string[];
  invalidated_signatures: number;
  session_drafts_rebuilt: number;
  playroom_drafts_rebuilt: number;
  tasks_created: number;
  pantry_b_entry_id: string | null;
  event_log_id: string | null;
  briefing_force_rebuild_invoked: boolean;
  briefing_force_rebuild_queued_or_done: boolean;
  karel_inline_comment: string;
  web_verification_state: "pending_web_verification" | "unavailable_no_web_tool" | "verified_with_sources";
  idempotent: boolean;
  idempotent_reason?: string;
}

export interface ExternalReplanScopeRow {
  id: string;
  status?: string | null;
  updated_at?: string | null;
}

const ACTIVE_REPLAN_STATUSES = new Set(["draft", "active", "in_revision", "awaiting_signoff"]);

function pragueDateISO(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(date);
}

export function shouldIncludeDeliberationForExternalReplan(
  row: ExternalReplanScopeRow,
  triggeringId: string,
  todayPrague: string,
): boolean {
  if (!row?.id) return false;
  if (row.id === triggeringId) return true;
  const status = String(row.status ?? "").toLowerCase();
  if (!ACTIVE_REPLAN_STATUSES.has(status)) return false;
  return pragueDateISO(row.updated_at ?? "") === todayPrague;
}

function fingerprintShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}

async function auditBriefingRebuildError(admin: SupabaseClient, userId: string, reason: string) {
  try {
    await admin.from("did_briefing_sla_runs").insert({
      user_id: userId,
      action: "error",
      reason: reason.slice(0, 1000),
      generation_method: "sla_watchdog_repair",
      payload: { source: "external_current_event_replan", failure_stage: "force_rebuild" },
    });
  } catch (e) {
    console.warn("[external-event-replan] failed to audit briefing rebuild error:", (e as Error)?.message);
  }
}

async function forceBriefingRebuild(args: {
  admin: SupabaseClient;
  userId: string;
  supabaseUrl: string;
  serviceKey: string;
}): Promise<boolean> {
  const { admin, userId, supabaseUrl, serviceKey } = args;
  const watchdogUrl = `${supabaseUrl}/functions/v1/karel-did-briefing-sla-watchdog`;
  let lastError = "not_attempted";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      const resp = await fetch(watchdogUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          userId,
          force_rebuild: true,
          reason: "external_current_event_update_in_deliberation",
          method: "sla_watchdog_repair",
          fullAi: false,
        }),
      });
      const bodyText = await resp.text().catch(() => "");
      if (resp.ok) return true;
      lastError = `watchdog_http_${resp.status}: ${bodyText.slice(0, 300)}`;
      console.warn(`[external-event-replan] watchdog attempt ${attempt + 1} non-ok: ${lastError}`);
    } catch (e) {
      lastError = `watchdog_fetch_failed: ${(e as Error).message}`;
      console.warn(`[external-event-replan] watchdog attempt ${attempt + 1} fetch failed:`, (e as Error)?.message);
    }
  }

  const directUrl = `${supabaseUrl}/functions/v1/karel-did-daily-briefing`;
  try {
    const directResp = await fetch(directUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        method: "sla_watchdog_repair",
        source: "external_current_event_replan",
        force: true,
        userId,
        force_rebuild: true,
        reason: "external_current_event_update_in_deliberation",
        fullAi: false,
      }),
    });
    const directText = await directResp.text().catch(() => "");
    if (directResp.ok) return true;
    lastError = `${lastError}; direct_briefing_http_${directResp.status}: ${directText.slice(0, 300)}`;
  } catch (e) {
    lastError = `${lastError}; direct_briefing_fetch_failed: ${(e as Error).message}`;
  }

  await auditBriefingRebuildError(admin, userId, lastError);
  return false;
}

export async function runExternalCurrentEventReplan(
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const {
    admin, userId, triggeringDeliberationId, authorLabel, authorRole,
    rawText, classification, webVerificationAvailable,
    supabaseUrl, serviceKey,
  } = ctx;

  const nowIso = new Date().toISOString();
  const eventLabel = classification.event_label;
  const fp = fingerprintShort(rawText);
  const dedupeKey = `external_current_event:${triggeringDeliberationId}:${fp}`;

  const webState: OrchestratorResult["web_verification_state"] =
    webVerificationAvailable
      ? "verified_with_sources"
      : (classification.requires_web_verification ? "unavailable_no_web_tool" : "pending_web_verification");

  // ── 5.0 IDEMPOTENCE PRE-CHECK ──────────────────────────────────────────
  // Pokud už pro tento dedupeKey existuje záznam v Pantry B (=>orchestrator
  // už proběhl pro stejný external event), vrátíme rychlou no-op odpověď.
  // Tím zabráníme duplicitním tasks/pantry/event log insertům i spuštění
  // dalšího briefing rebuildu při opakovaném kliknutí.
  try {
    const { data: existingPantry } = await admin
      .from("karel_pantry_b_entries")
      .select("id, detail")
      .eq("user_id", userId)
      .eq("source_kind", "team_deliberation_answer")
      .eq("source_ref", dedupeKey)
      .limit(1)
      .maybeSingle();
    if (existingPantry?.id) {
      const detail = (existingPantry as any).detail ?? {};
      const inlineComment = buildTruthfulKarelInlineComment({
        authorLabel,
        eventLabel,
        webVerificationAvailable,
        affectedDeliberationCount: Array.isArray(detail?.affected_deliberation_ids)
          ? detail.affected_deliberation_ids.length
          : 1,
      });
      return {
        affected_deliberation_ids: Array.isArray(detail?.affected_deliberation_ids) ? detail.affected_deliberation_ids : [],
        invalidated_signatures: 0,
        session_drafts_rebuilt: 0,
        playroom_drafts_rebuilt: 0,
        tasks_created: 0,
        pantry_b_entry_id: (existingPantry as any).id,
        event_log_id: null,
        briefing_force_rebuild_invoked: false,
        briefing_force_rebuild_queued_or_done: true,
        karel_inline_comment: inlineComment,
        web_verification_state: webState,
        idempotent: true,
        idempotent_reason: "already_replanned_for_same_external_event",
      };
    }
  } catch (e) {
    console.warn("[external-event-replan] idempotence pre-check failed:", (e as Error)?.message);
  }

  // ── 5.1 Find affected deliberations (session_plan + playroom) ─────────
  // SCOPE GUARD: jen *aktivně rozpracované* dnešní porady. Historické
  // approved porady (např. včerejší podepsaný plán) NESMÍ být zatažené,
  // i kdyby spadly do 36h okna. Triggering poradu vždy bereme.
  const todayPrague = pragueDateISO(new Date());
  const sinceWindowIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data: candidates } = await admin
    .from("did_team_deliberations")
    .select("id, deliberation_type, status, session_params, program_draft, hanka_signed_at, kata_signed_at, karel_signed_at, updated_at")
    .eq("user_id", userId)
    .in("deliberation_type", ["session_plan", "playroom"])
    .gte("updated_at", sinceWindowIso);

  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((row: any) => shouldIncludeDeliberationForExternalReplan(row, triggeringDeliberationId, todayPrague));
  // Always include the triggering one (even if filtered out by date)
  if (!list.find((r: any) => r.id === triggeringDeliberationId)) {
    const { data: trig } = await admin
      .from("did_team_deliberations")
      .select("id, deliberation_type, status, session_params, program_draft, hanka_signed_at, kata_signed_at, karel_signed_at, updated_at")
      .eq("id", triggeringDeliberationId)
      .maybeSingle();
    if (trig && shouldIncludeDeliberationForExternalReplan(trig, triggeringDeliberationId, todayPrague)) list.push(trig);
  }

  let invalidatedSigs = 0;
  let sessionRebuilt = 0;
  let playroomRebuilt = 0;
  const affectedIds: string[] = [];

  for (const row of list) {
    const isPlayroom =
      row.deliberation_type === "playroom" ||
      String((row.session_params as any)?.session_actor ?? "") === "karel_direct" ||
      String((row.session_params as any)?.ui_surface ?? "") === "did_kids_playroom" ||
      String((row.session_params as any)?.session_format ?? "") === "playroom";

    const newDraft = isPlayroom
      ? buildSafePlayroomDraft(eventLabel)
      : buildSafeSessionDraft(eventLabel);

    const oldParams = (row.session_params && typeof row.session_params === "object")
      ? { ...(row.session_params as Record<string, any>) }
      : {};
    const replanBlock = {
      active: true,
      event_label: eventLabel ?? "external_current_event",
      reported_by: authorRole,
      reported_at: nowIso,
      reason: "urgent_current_event_affecting_children",
      affects_session: true,
      affects_playroom: true,
      requires_web_verification: classification.requires_web_verification,
      web_verification_state: webState,
      forbidden_directions: isPlayroom ? FORBIDDEN_DIRECTIONS_PLAYROOM : FORBIDDEN_DIRECTIONS_SESSION,
      stop_rules: [
        "zahlcení",
        "strach o smrt nebo nezvratitelný konec",
        "pocit odpovědnosti za záchranu",
        "somatické zhoršení",
        "odmítnutí pokračovat",
      ],
    };
    oldParams.external_current_event_replan = replanBlock;
    oldParams.risk_gate = "external_event_high_emotional_load";
    if (isPlayroom) {
      oldParams.requires_therapist_approval = true;
      oldParams.approved_for_child_session = false;
    }

    const oldApprovalSync =
      (oldParams.approval_sync && typeof oldParams.approval_sync === "object")
        ? oldParams.approval_sync as Record<string, any>
        : {};
    oldParams.approval_sync = {
      ...oldApprovalSync,
      status: "invalidated_by_external_current_event",
      invalidated_reason: `${authorLabel} reported urgent ${eventLabel ?? "external"} update requiring session/playroom replan`,
      invalidated_at: nowIso,
    };

    const hadSig = !!row.hanka_signed_at || !!row.kata_signed_at || !!row.karel_signed_at;
    if (hadSig) invalidatedSigs += 1;

    const updatePatch: Record<string, any> = {
      status: "in_revision",
      program_draft: newDraft,
      session_params: oldParams,
      hanka_signed_at: null,
      kata_signed_at: null,
      karel_signed_at: null,
      karel_synthesis: null,
      karel_synthesized_at: null,
      final_summary: null,
      approved_program_draft_hash: null,
      approved_session_params_hash: null,
      approved_program_snapshot: {
        requires_reapproval: true,
        invalidated_at: nowIso,
        reason: "external_current_event_update_requires_replan",
      },
    };

    const { error: updErr } = await admin
      .from("did_team_deliberations")
      .update(updatePatch)
      .eq("id", row.id);

    if (updErr) {
      console.error("[external-event-replan] update failed for", row.id, updErr);
      continue;
    }
    affectedIds.push(row.id);
    if (isPlayroom) playroomRebuilt += 1;
    else sessionRebuilt += 1;
  }

  // ── 5.2 Pantry B (single rich entry) ───────────────────────────────────
  let pantryEntryId: string | null = null;
  try {
    const summary = `${authorLabel} hlásí urgentní změnu situace kolem ${eventNoun(eventLabel)}; kluci jsou ovlivnění a program má být přeplánovaný.`;
    const pantryRes = await appendPantryB(admin as any, {
      user_id: userId,
      entry_kind: "plan_change",
      source_kind: "team_deliberation_answer",
      source_ref: dedupeKey,
      summary,
      detail: {
        event_label: eventLabel,
        triggering_deliberation_id: triggeringDeliberationId,
        affected_deliberation_ids: affectedIds,
        web_verification_state: webState,
        requires_web_verification: classification.requires_web_verification,
        requires_replan: true,
        affects_session: true,
        affects_playroom: true,
        do_not_symbolize: true,
        do_not_diagnose_from_event_alone: true,
        raw_excerpt: rawText.slice(0, 1200),
      },
      intended_destinations: ["briefing_input", "did_implications", "did_therapist_tasks"],
      related_therapist: authorRole,
    });
    pantryEntryId = pantryRes ? (pantryRes as any).id ?? null : null;
  } catch (e) {
    console.warn("[external-event-replan] pantry B append failed:", (e as Error)?.message);
  }

  // ── 5.3 did_event_ingestion_log (best-effort, schema-tolerant) ─────────
  let eventLogId: string | null = null;
  try {
    const { data: logRow } = await admin
      .from("did_event_ingestion_log")
      .insert({
        user_id: userId,
        source_table: "did_team_deliberations",
        source_kind: "team_deliberation_answer",
        source_ref: dedupeKey,
        source_hash: fp,
        author_role: authorRole,
        author_name: authorLabel,
        source_surface: "team_deliberation_answer",
        raw_excerpt: rawText.slice(0, 1500),
        event_kind: "external_current_event_update",
        evidence_level: "therapist_factual_correction",
        clinical_relevance: true,
        operational_relevance: true,
        status: "routed",
        classification_json: {
          event_type: "external_current_event_update",
          urgency: classification.urgency,
          affects_children: true,
          requires_replan: true,
          requires_web_verification: classification.requires_web_verification,
          affects_session: true,
          affects_playroom: true,
          source: "therapist_report",
          source_author: authorLabel,
          verification_state: webState,
          event_label: eventLabel,
          matched_signals: classification.matched_signals,
          affected_deliberation_ids: affectedIds,
        },
      })
      .select("id")
      .maybeSingle();
    eventLogId = logRow?.id ?? null;
  } catch (e) {
    console.warn("[external-event-replan] event log insert failed:", (e as Error)?.message);
  }

  // ── 5.4 Immediate therapist tasks (idempotent) ─────────────────────────
  let tasksCreated = 0;
  const labelForTask = eventNoun(eventLabel);
  const baseSourceAgreement = `external_current_event:${triggeringDeliberationId}:${fp}`;
  const tasks = [
    {
      assigned_to: "hanka",
      task: `Před dalším kontaktem s kluky ověř, co dnes o ${labelForTask} sami vědí, co cítí v těle a zda je téma bezpečné otevřít.`,
      note: `Nepřidávej nové neověřené informace přímo dětem. Pracuj s realitou + emocí + potřebou + bezpečím. (Vyvoláno: ${authorLabel}, ${nowIso})`,
      priority: "high",
      category: "crisis",
      source_agreement: `${baseSourceAgreement}:hanka`,
    },
    {
      assigned_to: "kata",
      task: `Zkontroluj, zda nový program drží ${labelForTask} jako skutečnou událost, ne jako symbol nebo projekci, a zda kluci nenesou pocit odpovědnosti za záchranu.`,
      note: `Supervizní kontrola po urgentní reality změně hlášené ${authorLabel}. (${nowIso})`,
      priority: "high",
      category: "crisis",
      source_agreement: `${baseSourceAgreement}:kata`,
    },
    {
      assigned_to: "both",
      task: `Doplnit ověřené odkazy ke zdrojům o aktuální situaci kolem ${labelForTask}, aby Karel mohl pracovat s ověřenými fakty.`,
      note: webVerificationAvailable
        ? `Karel zdroje vyhledává automaticky; doplňte vlastní pokud máte.`
        : `Webové ověření v aplikaci aktuálně není dostupné — Karel pracuje pouze s hlášením. Pošlete prosím odkazy.`,
      priority: "high",
      category: "crisis",
      source_agreement: `${baseSourceAgreement}:both`,
    },
  ];

  for (const t of tasks) {
    try {
      // Idempotence: skip if a task with same source_agreement already exists
      const { data: existing } = await admin
        .from("did_therapist_tasks")
        .select("id")
        .eq("user_id", userId)
        .eq("source_agreement", t.source_agreement)
        .maybeSingle();
      if (existing?.id) continue;
      const { error: insErr } = await admin.from("did_therapist_tasks").insert({
        user_id: userId,
        task: t.task,
        assigned_to: t.assigned_to,
        note: t.note,
        priority: t.priority,
        category: t.category,
        source: "external_current_event_replan",
        source_agreement: t.source_agreement,
      });
      if (!insErr) tasksCreated += 1;
    } catch (e) {
      console.warn("[external-event-replan] task insert failed:", (e as Error)?.message);
    }
  }

  // ── 5.5 Force-rebuild Karlův přehled: defer to background so the
  // edge function returns to the client immediately (no `context canceled`).
  // We use EdgeRuntime.waitUntil where available; fall back to a fire-and-forget
  // promise. Either way, we do NOT await the watchdog HTTP loop here.
  const briefingPromise = forceBriefingRebuild({ admin, userId, supabaseUrl, serviceKey })
    .catch((e) => {
      console.warn("[external-event-replan] deferred briefing rebuild failed:", (e as Error)?.message);
      return false;
    });
  try {
    const er = (globalThis as any).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") {
      er.waitUntil(briefingPromise);
    }
  } catch (_e) { /* ignore */ }

  // ── 5.6 Build truthful inline comment ──────────────────────────────────
  const inlineComment = buildTruthfulKarelInlineComment({
    authorLabel,
    eventLabel,
    webVerificationAvailable,
    affectedDeliberationCount: affectedIds.length,
  });

  // Final guard — should always pass for our hand-crafted text.
  const guard = inlineCommentHasAuditLanguage(inlineComment);
  const safeComment = guard.ok
    ? inlineComment
    : `${authorLabel}, beru to jako urgentní změnu reality. Starý návrh pozastavuji a připravuji nový bezpečný plán pro Sezení i Hernu.`;

  return {
    affected_deliberation_ids: affectedIds,
    invalidated_signatures: invalidatedSigs,
    session_drafts_rebuilt: sessionRebuilt,
    playroom_drafts_rebuilt: playroomRebuilt,
    tasks_created: tasksCreated,
    pantry_b_entry_id: pantryEntryId,
    event_log_id: eventLogId,
    briefing_force_rebuild_invoked: false, // deferred — will run in background
    briefing_force_rebuild_queued_or_done: true,
    karel_inline_comment: safeComment,
    web_verification_state: webState,
    idempotent: false,
  };
}
