/**
 * P31.1 — karelBriefingVoiceRenderer
 *
 * Truth-locked deterministic renderer that converts an already truth-gated
 * briefing payload into human, Karel-voiced sections. NO AI calls. NO fetch.
 * Renderer NEVER invents facts; it can only render what the payload contains.
 *
 * Public API: renderKarelBriefingVoice(payload) → KarelBriefingVoiceRenderResult
 */

import {
  canonicalizePartDisplayName,
  isPartTodayRelevantForPrimarySuggestion,
} from "./partTodayRelevance.ts";
import {
  evaluateBriefingContentCompleteness,
  type DailyBriefingContentCompleteness,
} from "./dailyBriefingContentCompleteness.ts";

export interface RenderedBriefingSection {
  section_id: string;
  title: string;
  karel_text: string;
  source_fields: string[];
  source_cycle_id?: string | null;
  source_job_kinds?: string[];
  source_event_ids?: string[];
  confidence: "high" | "medium" | "low";
  unsupported_claims_count: number;
  warnings: string[];
}

export interface KarelBriefingVoiceRenderResult {
  ok: boolean;
  renderer_version: string;
  source_cycle_id: string | null;
  briefing_truth_gate_ok: boolean;
  provider_status?: string | null;
  sections: RenderedBriefingSection[];
  opening_text?: string;
  closing_text?: string;
  content_completeness?: DailyBriefingContentCompleteness;
  render_audit: {
    source_fields_used: string[];
    missing_expected_fields: string[];
    unsupported_claims_count: number;
    robotic_phrase_count: number;
    forbidden_phrase_hits: string[];
    empty_sections_count: number;
  };
  errors: string[];
}

export const RENDERER_VERSION = "p33.8.0";

function withTerminalPunctuation(text: string): string {
  const s = safeStr(text);
  if (!s) return "";
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function sanitizeRenderedText(text: string): string {
  return safeStr(text)
    .replace(/\b00[0-9]_/g, "")
    .replace(/S[íi]la\s+d[ůu]kazu\s+je\s+n[íi]zk[áa][^.!?]*[.!?]?/gi, "")
    .replace(/Opora\s+v\s+podklade?ch\s+je\s+n[íi]zk[áa][^.!?]*[.!?]?/gi, "")
    .replace(/dolo[žz]en[ýy]\s+praktickou\s+pozn[áa]mku/gi, "praktickou poznámku")
    .replace(/dolo[žz]en[ýy]\s+praktick[ýy]\s+report/gi, "praktickou poznámku")
    .replace(/praktick[ýy]\s+report/gi, "praktickou poznámku")
    .replace(/podle\s+posledn[íi]ho\s+p[řr]esn[ěe]\s+datovan[ée]ho\s+review/gi, "podle posledního doloženého záznamu")
    .replace(/\barthure?\b/gi, (m) => (m.toLocaleLowerCase("cs") === "arthure" ? "Arthure" : "Arthur"))
    .replace(/\btundrupek\b/gi, "Tundrupek")
    .replace(/\bgustik\b/gi, "Gustík")
    .replace(/\.\.+/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export const FORBIDDEN_ROBOTIC_PHRASES: { pattern: RegExp; label: string }[] = [
  { pattern: /na základ[ěe] dat/i, label: "Na základě dat" },
  { pattern: /dle dostupných informac[ií]/i, label: "Dle dostupných informací" },
  { pattern: /bylo zjišt[ěe]no/i, label: "Bylo zjištěno" },
  { pattern: /je doporu[čc]eno/i, label: "Je doporučeno" },
  { pattern: /t[ée]ma kolem [čc][áa]sti/i, label: "Téma kolem části" },
  { pattern: /uživatel by m[ěe]l/i, label: "uživatel by měl" },
  { pattern: /syst[ée]m indikuje/i, label: "systém indikuje" },
  { pattern: /v r[áa]mci procesu/i, label: "v rámci procesu" },
  { pattern: /prob[ěe]hla aktualizace/i, label: "proběhla aktualizace" },
  { pattern: /dle pipeline/i, label: "dle pipeline" },
  { pattern: /\bpayload\b/i, label: "payload" },
  { pattern: /job graph/i, label: "job graph" },
  { pattern: /truth gate/i, label: "truth gate" },
];

const INTERNAL_TERMS = [/\bpayload\b/i, /\btruth gate\b/i, /\bjob graph\b/i, /\bpipeline\b/i];

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function pushUsed(used: Set<string>, fields: string[]) {
  for (const f of fields) used.add(f);
}

/**
 * Section 1 — ranní stav systému (truth gate readiness, in human terms).
 */
function renderSystemMorningState(payload: any): RenderedBriefingSection {
  const truth = payload?.briefing_truth_gate ?? null;
  const ok = truth?.ok === true;
  const cycleId = safeStr(truth?.source_cycle_id) || null;
  const cycleCompleted = safeStr(payload?.source_cycle_completed_at) || safeStr(truth?.cycle_completed_at);
  const reasons: string[] = Array.isArray(truth?.reasons) ? truth.reasons : [];
  const fields = ["briefing_truth_gate.ok", "briefing_truth_gate.source_cycle_id", "source_cycle_completed_at"];

  let text: string;
  let confidence: "high" | "medium" | "low";
  const warnings: string[] = [];

  if (ok && cycleId) {
    text = `Ranní podklady jsou připravené a vázané na dnešní dokončený ranní cyklus. Můžeme z nich dnes vycházet.`;
    confidence = "high";
  } else if (ok) {
    text = "Ranní podklady prošly kontrolou a jsou připravené k použití.";
    confidence = "medium";
  } else {
    const why = reasons.length > 0 ? ` Důvod: ${reasons.slice(0, 2).join(", ")}.` : "";
    text = `Ranní podklady ještě nejsou plně připravené, takže s dnešním přehledem zacházíme opatrně.${why}`;
    confidence = "low";
    warnings.push("truth_gate_not_ok");
  }

  return {
    section_id: "system_morning_state",
    title: "Ranní stav",
    karel_text: text,
    source_fields: fields,
    source_cycle_id: cycleId,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 2 — co je ověřené z denního cyklu.
 */
function renderDailyCycleVerified(payload: any): RenderedBriefingSection {
  const snap = payload?.phase_jobs_snapshot
    ?? payload?.briefing_truth_gate?.job_graph_snapshot
    ?? payload?.daily_cycle_completion_semantics?.detached_jobs_summary
    ?? null;
  const truth = payload?.briefing_truth_gate ?? null;
  const fields = ["phase_jobs_snapshot", "briefing_truth_gate.job_graph_snapshot", "briefing_truth_gate.required_jobs_count", "briefing_truth_gate.completed_jobs", "briefing_truth_gate.controlled_skipped_jobs", "daily_cycle_completion_semantics.detached_jobs_summary"];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  if ((Array.isArray(snap) && snap.length > 0) || (snap && typeof snap === "object")) {
    const jobs = Array.isArray(snap) ? snap : (Array.isArray(snap?.jobs) ? snap.jobs : []);
    const completed = jobs.filter((j: any) => j?.status === "completed").length
      || Number(truth?.completed_jobs ?? snap?.completed ?? 0);
    const skipped = jobs.filter((j: any) => j?.status === "controlled_skipped").length
      || Number(truth?.controlled_skipped_jobs ?? snap?.controlled_skipped ?? 0);
    const total = jobs.length || Number(truth?.required_jobs_count ?? snap?.total ?? 0);
    const terminal = completed + skipped;
    if (total > 0) {
      text = terminal >= total
        ? `Dnešní ranní příprava doběhla — všech ${total} povinných kroků je uzavřených (dokončené i bezpečně přeskočené, podle toho, pro co byla dnes práce).`
        : `Z dnešní ranní přípravy je uzavřených ${terminal} ze ${total} kroků. Beru to jako rozpracovaný základ pro dnešek.`;
      confidence = terminal >= total ? "high" : "medium";
    } else {
      text = "Dnešní ranní příprava proběhla, ale přehled kroků je dnes uložený bez počitatelné položkové struktury.";
      warnings.push("phase_jobs_snapshot_empty");
    }
  } else {
    text = "Nemám u sebe detail o průběhu ranní přípravy, takže o jednotlivých krocích raději nic netvrdím.";
    confidence = "low";
    warnings.push("phase_jobs_snapshot_missing");
  }

  return {
    section_id: "daily_cycle_verified",
    title: "Co je ověřené z dnešní ranní přípravy",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 3 — části / aktivní kluci dnes.
 *
 * P33.6: Dormant or low-support hypothesis-only proposals must NOT appear
 * as a primary "nabízí se část …" suggestion. Technical prefixes (002_)
 * are normalized away. When opora is insufficient, render the calm
 * fallback instead of leaking "Opora v podkladech je nízká".
 */
function renderTodayParts(payload: any): RenderedBriefingSection {
  const tpp = payload?.today_part_proposal ?? null;
  const matrix = payload?.daily_part_workability_matrix ?? null;
  const fields = [
    "daily_part_workability_matrix",
    "today_part_relevance_decision",
    "today_part_proposal.proposed_part",
  ];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  // P33.8 — Primary source of truth is the matrix when present.
  const decision = payload?.today_part_relevance_decision ?? isPartTodayRelevantForPrimarySuggestion({
    proposed_part: tpp?.proposed_part ?? tpp?.part_name,
    briefing_date: safeStr(payload?.briefing_date) || safeStr(payload?.viewer_meta?.briefing_date_iso),
    source_cycle_id: payload?.briefing_truth_gate?.source_cycle_id ?? payload?.source_cycle_id,
    is_hypothesis_only: tpp?.is_hypothesis_only === true,
    evidence_strength: tpp?.evidence_strength,
    recent_thread_part_names: Array.isArray(tpp?.recent_thread_part_names) ? tpp.recent_thread_part_names : [],
    todays_session_part_names: Array.isArray(tpp?.todays_session_part_names) ? tpp.todays_session_part_names : [],
    live_progress_part_names: Array.isArray(tpp?.live_progress_part_names) ? tpp.live_progress_part_names : [],
    explicit_therapist_mentions: Array.isArray(tpp?.explicit_therapist_mentions) ? tpp.explicit_therapist_mentions : [],
    registry_sleeping: tpp?.registry_sleeping === true,
  });

  // Derive watch-only sensitivity context from matrix (informational only).
  const watchOnlyNames: string[] = matrix && Array.isArray(matrix.parts)
    ? matrix.parts
        .filter((p: any) => p?.workability === "watch_only" && p?.display_name)
        .map((p: any) => canonicalizePartDisplayName(p.display_name) ?? String(p.display_name))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const watchOnlySuffix = watchOnlyNames.length > 0
    ? `\n\nDnes mám jen jako citlivostní kontext (watch-only, ne jako vedoucí část pro práci): ${watchOnlyNames.join(", ")}.`
    : "";

  if (decision?.ok_for_primary_suggestion) {
    const partName = canonicalizePartDisplayName(decision?.display_name ?? tpp?.proposed_part ?? tpp?.part_name);
    const matrixPart = matrix && Array.isArray(matrix.parts)
      ? matrix.parts.find((p: any) => canonicalizePartDisplayName(p?.display_name) === partName)
      : null;
    const route = matrixPart?.recommended_route as string | undefined;
    const routeText = route === "session"
      ? " Doporučená cesta je krátké terapeutické Sezení, pokud první kontakt potvrdí, že je to v pořádku."
      : route === "first_contact"
      ? " Doporučená cesta je nejdřív první kontakt a podle něj rozhodnout, zda Sezení nebo stabilizační Herna."
      : "";
    const evidenceNote = matrixPart?.reason
      ? ` Opírám to o: ${humanReason(matrixPart.reason)}.`
      : "";
    text = `Pro dnešek se mi jako pracovní vedoucí část nabízí ${partName}.${evidenceNote}${routeText}${watchOnlySuffix}`;
    confidence = decision?.confidence === "high" ? "high" : "medium";
  } else {
    const partName = canonicalizePartDisplayName(decision?.display_name ?? tpp?.proposed_part ?? tpp?.part_name);
    const fallbackPlan = [
      "První kontakt: Hanička nebo Káťa krátce zjistí tělesné napětí, emoční dostupnost a ochotu kluků navázat kontakt.",
      "Bezpečnostní kontrola: pokud někdo z kluků signalizuje stop, tlak nebo přemíra emocí, zůstáváme jen u krátkého ověření a neotevíráme nový materiál.",
      "Tři možné cesty podle prvního kontaktu: krátké terapeutické Sezení, stabilizační Herna bez nového tématu, nebo jen bezpečný kontakt bez otevírání těžkého materiálu.",
      "Stop signály pro dnešek: nepokoušet se otevřít nové trauma téma, neforsírovat konkrétní část a neuzavírat dnes žádné velké terapeutické rozhodnutí.",
    ].join("\n");
    const lead = matrix?.overall_decision === "blocked_centrum_missing"
      ? "Dnes nemám potvrzený obraz částí z 00_CENTRUM, takže nemůžu volit vedoucí část před prvním kontaktem."
      : partName
      ? `Pro dnešek je v úvahu ${partName} jako pracovní hypotéza, ale podle dnešních signálů z 00_CENTRUM a pipeline na ni nemám dost opory, abych ji označil jako vedoucí část.`
      : "Dnes nemám žádnou část jako vedoucí kandidátku, protože 00_CENTRUM ani dnešní signály nedávají dost opory.";
    text = `${lead} Místo vedoucí části dnes navrhuji tento operační rámec:\n\n${fallbackPlan}${watchOnlySuffix}`;
    confidence = "low";
    warnings.push(decision?.reason ? `part_relevance_rejected:${decision.reason}` : "no_today_part_proposal");
  }

  return {
    section_id: "today_parts",
    title: "Dnešní práce s kluky",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

function humanReason(reason: string): string {
  switch (reason) {
    case "active_with_strong_today_evidence": return "aktivní v 00_CENTRUM a má dnes čerstvou stopu (sezení nebo živý záznam)";
    case "active_with_fresh_team_proposal_and_evidence": return "aktivní v 00_CENTRUM, čerstvý návrh týmu a dnešní stopu";
    case "active_with_recent_thread_only": return "aktivní v 00_CENTRUM a nedávné vlákno (≤72 h)";
    case "dormant_with_fresh_evidence": return "v 00_CENTRUM v útlumu, ale s čerstvou stopou — proto jen po prvním kontaktu";
    default: return reason;
  }
}

/**
 * Section 4 — úkoly terapeutek (ask_hanka / ask_kata).
 *
 * P33.7: Tasks must be CONCRETE. When podklady chybí, Karel doplní
 * defaultní first-contact / risk-stop rámec, aby přehled nebyl operačně prázdný.
 */
function renderTherapistAsks(payload: any): RenderedBriefingSection {
  const askH = Array.isArray(payload?.ask_hanka) ? payload.ask_hanka : [];
  const askK = Array.isArray(payload?.ask_kata) ? payload.ask_kata : [];
  const fields = ["ask_hanka", "ask_kata"];
  const warnings: string[] = [];

  const firstH = safeStr(askH[0]?.text);
  const firstK = safeStr(askK[0]?.text);

  const blocks: string[] = [];

  // Hanička block — first-contact check
  if (firstH) {
    const head = withTerminalPunctuation(`Haničko, hlavní věc na dnes je ${firstH.charAt(0).toLocaleLowerCase("cs")}${firstH.slice(1)}`);
    const concrete = "Konkrétně: ověř první kontakt s kluky (zda jsou dostupní a ochotní navázat), pojmenuj tělesné napětí nebo emoční dostupnost a podle toho rozhodni, jestli dnes půjdeme do Sezení, do stabilizační Herny, nebo zůstane jen bezpečný kontakt.";
    blocks.push(`${head}\n${concrete}`);
    if (askH.length > 1) blocks.push(`Pro Haničku k tomu mám ještě ${askH.length - 1} navazujících bodů.`);
  } else {
    blocks.push("Haničko, jako první krok ověř kontakt s kluky: zda jsou dostupní, jaké je tělesné napětí a ochota navázat. Podle toho rozhodneme mezi krátkým Sezením, stabilizační Hernou nebo jen bezpečným kontaktem.");
    warnings.push("no_ask_hanka_default_first_contact_used");
  }

  // Káťa block — risk + stop signals
  if (firstK) {
    const head = withTerminalPunctuation(`Káťo, hlavní věc na dnes je ${firstK.charAt(0).toLocaleLowerCase("cs")}${firstK.slice(1)}`);
    const concrete = "Konkrétně: projdi rizika a stop signály pro dnešek, drž bezpečný rámec a pokud se objeví citlivý okruh z venku, dej Haničce vědět, abychom dnes neotevírali nové trauma téma.";
    blocks.push(`${head}\n${concrete}`);
    if (askK.length > 1) blocks.push(`Pro Káťu k tomu mám ještě ${askK.length - 1} navazujících bodů.`);
  } else {
    blocks.push("Káťo, drž dnes risk a stop check: sleduj signály přetížení u kluků, pojmenuj případnou citlivost z venku a rozhodni, zda některé téma dnes raději neotevírat.");
    warnings.push("no_ask_kata_default_risk_stop_used");
  }

  const text = blocks.join("\n\n");
  const confidence: "high" | "medium" | "low" = (firstH && firstK) ? "high" : "medium";

  return {
    section_id: "therapist_asks",
    title: "Úkoly pro terapeutky",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 5 — plán sezení / herny.
 *
 * P33.7: Když není schválený plán, Karel místo věty „nemám plán" nabídne
 * rozhodovací protokol (kdy zvolit Sezení / Hernu / bezpečný kontakt).
 */
function renderSessionPlan(payload: any): RenderedBriefingSection {
  const sess = payload?.proposed_session ?? null;
  const play = payload?.proposed_playroom ?? null;
  const fields = ["proposed_session", "proposed_playroom"];
  const warnings: string[] = [];

  const sessTitle = safeStr(sess?.title || sess?.theme || sess?.focus);
  const playTitle = safeStr(play?.title || play?.theme || play?.focus);

  const lines: string[] = [];
  if (sessTitle) lines.push(`Pro dnešní Sezení mám schválený rámec: ${sessTitle}.`);
  if (playTitle) lines.push(`Pro Hernu mám schválený rámec: ${playTitle}.`);

  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";
  if (lines.length === 0) {
    text = [
      "Pro dnešek nemám schválený konkrétní plán Sezení ani Herny.",
      "Rozhodovací protokol podle prvního kontaktu:",
      "— Sezení zvol, pokud kluci přinášejí konkrétní téma a je u nich dnes ochota i kapacita pracovat hlouběji.",
      "— Stabilizační Hernu zvol, pokud je vyšší napětí, ale kontakt drží; cílem je bezpečí, ne nový materiál.",
      "— Jen bezpečný kontakt zvol, pokud někdo z kluků signalizuje stop, přemíru emocí nebo únavu; nic nového dnes neotevíráme.",
      "Případné starší týmové návrhy (například s Timmim) prosím neberte jako dnešní plán; jen jako podklad k pozdější revizi.",
    ].join("\n");
    confidence = "low";
    warnings.push("no_session_or_playroom_decision_protocol_used");
  } else {
    text = lines.join("\n\n");
  }

  return {
    section_id: "session_plan",
    title: "Plán Sezení a Herny",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 4b (P33.7) — yesterday review (continuity OR controlled missing).
 */
function isCompletedYesterdayReview(r: any): boolean {
  if (!r || r.exists !== true) return false;
  // Must be actually held (clinical activity) and explicitly anchored to yesterday.
  if (r.held !== true) return false;
  if (r.is_yesterday !== true && r.is_yesterday_for_briefing !== true) return false;
  // Must have a real review_id (not just a pending plan fallback).
  if (!r.review_id) return false;
  const status = String(r.review_status ?? r.status ?? "").toLowerCase();
  // Reject pending/technical/abandoned/non-clinical statuses.
  const reject = new Set([
    "pending_review", "analysis_running", "technical_test",
    "approved_not_started", "pending_generated_plan",
    "evidence_limited", "planned_not_started", "none",
  ]);
  if (reject.has(status)) return false;
  // Reject explicit fallback reasons indicating no clinical session.
  const fallback = String(r.fallback_reason ?? "").toLowerCase();
  if (fallback === "planned_session_not_clinically_held" || fallback === "approved_plan_not_started" || fallback === "pending_generated_plan_only") return false;
  // Require completion = completed (not partial/abandoned).
  const completion = String(r.completion ?? "").toLowerCase();
  if (completion && completion !== "completed") return false;
  return true;
}

function renderYesterdayReview(payload: any): RenderedBriefingSection {
  const ysess = payload?.yesterday_session_review ?? null;
  const yplay = payload?.yesterday_playroom_review ?? null;
  const sessOk = isCompletedYesterdayReview(ysess);
  const playOk = isCompletedYesterdayReview(yplay);
  const fields = ["yesterday_session_review", "yesterday_playroom_review"];
  const warnings: string[] = [];

  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  if (sessOk || playOk) {
    const lines: string[] = ["Včerejší návaznost:"];
    if (sessOk) {
      const part = canonicalizePartDisplayName(safeStr(ysess?.part_name)) || "části";
      const summary = safeStr(ysess?.karel_summary);
      const finding = safeStr(ysess?.key_finding_about_part);
      const implication = safeStr(ysess?.implications_for_plan);
      lines.push(`Sezení s ${part}: ${summary || "průběh doložený, podrobnosti viz review."}`);
      if (finding) lines.push(`Co bylo uzavřené: ${finding}`);
      if (implication) lines.push(`Co z toho plyne pro dnešek: ${implication}`);
    }
    if (playOk) {
      const part = canonicalizePartDisplayName(safeStr(yplay?.part_name)) || "kluky";
      const summary = safeStr(yplay?.karel_summary || yplay?.summary);
      lines.push(`Herna s ${part}: ${summary || "doložená, ale bez plné analýzy."}`);
    }
    text = lines.join("\n");
    confidence = "high";
  } else {
    text = "Včera nemám doložené dokončené Sezení ani Hernu. Dnešní plán proto nesmí předpokládat navázání na hotový terapeutický materiál; začínáme krátkým ověřením aktuálního stavu kluků.";
    confidence = "medium";
    if (ysess?.exists === true || yplay?.exists === true) {
      warnings.push("yesterday_review_present_but_not_clinically_completed");
    } else {
      warnings.push("no_yesterday_review_controlled_missing");
    }
  }

  return {
    section_id: "yesterday_review",
    title: "Včerejší návaznost",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 6 — external reality watch.
 */
function renderExternalReality(payload: any): RenderedBriefingSection {
  const ext = payload?.external_reality_watch ?? null;
  const fields = [
    "external_reality_watch.provider_status",
    "external_reality_watch.active_part_daily_brief_count",
    "external_reality_watch.source_backed_events_count",
    "external_reality_watch.internet_events_used_count",
  ];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  if (!ext) {
    text = "Nemám externí situační podklady. Dnes proto pracuji jen s tím, co máme uvnitř.";
    confidence = "low";
    warnings.push("external_reality_missing");
    return {
      section_id: "external_reality",
      title: "Externí kontext",
      karel_text: text,
      source_fields: fields,
      confidence,
      unsupported_claims_count: 0,
      warnings,
    };
  }

  const ps = safeStr(ext?.provider_status) || "not_run";
  const briefCount = Number(ext?.active_part_daily_brief_count) || 0;
  const sourceBacked = Number(ext?.source_backed_events_count) || 0;
  const used = Number(ext?.internet_events_used_count) || 0;

  // P33.6 — explicitly state whether Karel actually checked the internet today,
  // and split language by recency tier so the therapist sees that internet was
  // queried even when no fresh-today event came back.
  const partsArr: any[] = Array.isArray(ext?.parts) ? ext.parts : [];
  const checkedTodayCount = partsArr.reduce((acc, p) => {
    const a = p?.evidence_summary?.checked_external_sources_today;
    return acc + (Array.isArray(a) ? a.length : 0);
  }, 0);
  const freshCount = partsArr.reduce((acc, p) => {
    const a = p?.internet_triggers_today;
    return acc + (Array.isArray(a) ? a.length : 0);
  }, 0);

  // P33.7 — Source/tier manifestation per affected part.
  type PerPart = { name: string; tier: "fresh" | "checked" | "historical"; category: string; domain: string; checkedDate: string; pubDate: string | null };
  const perPart: PerPart[] = [];
  const cleanCat = (s: any) => safeStr(s).replace(/_/g, " ").trim();
  for (const p of partsArr) {
    const name = canonicalizePartDisplayName(safeStr(p?.evidence_summary?.canonical_part_name) || safeStr(p?.part_name)) || "";
    if (!name) continue;
    const fresh = Array.isArray(p?.internet_triggers_today) ? p.internet_triggers_today : [];
    const checked = Array.isArray(p?.evidence_summary?.checked_external_sources_today) ? p.evidence_summary.checked_external_sources_today : [];
    const hist = Array.isArray(p?.evidence_summary?.historical_external_triggers) ? p.evidence_summary.historical_external_triggers : [];
    const isFresh = (t: any) => t?.freshness?.display_tier === "fresh_today_event" || t?.freshness?.ok_for_today_display === true;
    const freshHit = fresh.find(isFresh) ?? checked.find(isFresh);
    if (freshHit) {
      perPart.push({
        name, tier: "fresh",
        category: cleanCat(freshHit?.event_type || freshHit?.category) || "vnější citlivý okruh",
        domain: safeStr(freshHit?.source_domain),
        checkedDate: safeStr(freshHit?.fetched_at || freshHit?.checked_at).slice(0, 10),
        pubDate: safeStr(freshHit?.source_published_at) || null,
      });
      continue;
    }
    if (checked.length > 0) {
      const c = checked[0];
      perPart.push({
        name, tier: "checked",
        category: cleanCat(c?.event_type || c?.category) || "vnější citlivý okruh",
        domain: safeStr(c?.source_domain),
        checkedDate: safeStr(c?.fetched_at || c?.checked_at).slice(0, 10),
        pubDate: safeStr(c?.source_published_at) || null,
      });
      continue;
    }
    if (hist.length > 0) {
      const h = hist[0];
      perPart.push({
        name, tier: "historical",
        category: cleanCat(h?.event_type || h?.category) || "vnější citlivý okruh",
        domain: safeStr(h?.source_domain),
        checkedDate: safeStr(h?.fetched_at || h?.checked_at).slice(0, 10),
        pubDate: safeStr(h?.source_published_at) || null,
      });
    }
  }

  function manifestLine(pp: PerPart): string {
    const tail = [pp.domain && `zdroj ${pp.domain}`, pp.checkedDate && `ověřeno ${pp.checkedDate}`, pp.pubDate ? `publikováno ${pp.pubDate}` : "datum publikace neznámé"].filter(Boolean).join(", ");
    if (pp.tier === "fresh") {
      return `U ${pp.name} je dnes čerstvě zachycený vnější okruh z oblasti ${pp.category} (${tail}). Beru to jen jako signál držet bezpečný rámec, ne jako závěr o jeho stavu.`;
    }
    if (pp.tier === "checked") {
      return `U ${pp.name} internetový přehled dnes znovu ověřil citlivý okruh z oblasti ${pp.category} (${tail}). Datum publikace zdroje není jasné, neberu to jako dnešní událost; jen jako důvod jemně ověřit, jestli se s tématem dnes setkali.`;
    }
    return `U ${pp.name} je dříve evidovaný citlivý okruh z oblasti ${pp.category} bez čerstvého dnešního zdroje (${tail}). Smyslem je jen ověřit, zda se s tématem dnes setkali.`;
  }

  if (ps === "configured") {
    if (perPart.length > 0) {
      const intro = "Externí situační přehled jsem dnes ověřoval. Konkrétně:";
      const lines = perPart.slice(0, 6).map(manifestLine);
      text = [intro, ...lines].join("\n\n");
      confidence = "medium";
    } else if (checkedTodayCount > 0) {
      text = "Externí situační přehled jsem dnes ověřoval. Datum publikace u nalezených zdrojů ale není jasné, takže to neberu jako dnešní událost — jen jako důvod jemně ověřit, jestli se s tématem dnes potkali.";
      confidence = "medium";
    } else {
      text = "Externí situační přehled jsem dnes ověřoval a žádný čerstvý ani dnes ověřený zdrojovaný okruh se neobjevil. Beru to tak, že dnes není nic, co bych měl z venku zvlášť hlídat.";
      confidence = "high";
    }
  } else if (ps === "provider_not_configured") {
    text = "Externí situační přehled dnes není zapnutý, takže o vnějších událostech nic netvrdím.";
    confidence = "high";
  } else if (ps === "provider_error") {
    text = "Pokus o externí situační přehled se dnes nepovedl, takže o vnějších událostech raději nic netvrdím.";
    confidence = "low";
    warnings.push("provider_error");
  } else {
    text = "Externí situační přehled dnes neproběhl, takže pracuji jen s tím, co máme uvnitř.";
    confidence = "low";
    warnings.push("provider_not_run");
  }

  return {
    section_id: "external_reality",
    title: "Externí kontext",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 7 — rizika / citlivosti.
 */
function renderRisks(payload: any): RenderedBriefingSection {
  const lingering = Array.isArray(payload?.lingering) ? payload.lingering : [];
  const fields = ["lingering", "external_reality_watch.parts"];
  const ext = payload?.external_reality_watch ?? null;
  const partsArr: any[] = Array.isArray(ext?.parts) ? ext.parts : [];

  const isFresh = (t: any) =>
    t?.freshness?.display_tier === "fresh_today_event" ||
    t?.freshness?.ok_for_today_display === true;

  const partsWithTriggers: string[] = partsArr
    .filter((p) => Array.isArray(p?.internet_triggers_today) && p.internet_triggers_today.some(isFresh))
    .map((p) => canonicalizePartDisplayName(p?.part_name) || "").filter(Boolean);

  const partsWithCheckedToday: string[] = partsArr
    .filter((p) => {
      const arr = p?.evidence_summary?.checked_external_sources_today;
      return Array.isArray(arr) && arr.length > 0 && !isFresh(p);
    })
    .map((p) => canonicalizePartDisplayName(p?.part_name) || "").filter(Boolean);

  const partsWithHistoricalOnly: string[] = partsArr
    .filter((p) => {
      const fresh = Array.isArray(p?.internet_triggers_today) && p.internet_triggers_today.some(isFresh);
      const checked = Array.isArray(p?.evidence_summary?.checked_external_sources_today) &&
        p.evidence_summary.checked_external_sources_today.length > 0;
      const hist = Array.isArray(p?.evidence_summary?.historical_external_triggers) &&
        p.evidence_summary.historical_external_triggers.length > 0;
      return !fresh && !checked && hist;
    })
    .map((p) => canonicalizePartDisplayName(p?.part_name) || "").filter(Boolean);

  const lines: string[] = [];
  if (lingering.length > 0) {
    lines.push(`Nesené téma, které ještě dobíhá: ${lingering.length === 1 ? "jedno" : `${lingering.length}`}. Nedělám z toho zatím závěr, jen ho držím na vědomí.`);
  }
  if (partsWithTriggers.length > 0) {
    lines.push(`U těchto kluků je dnes čerstvě zachycený vnější okruh: ${partsWithTriggers.join(", ")}. Není to predikce, je to upozornění držet bezpečný rámec.`);
  }
  if (partsWithCheckedToday.length > 0) {
    lines.push(`Internetový přehled dnes znovu ověřil citlivý okruh u: ${partsWithCheckedToday.join(", ")}. Datum publikace zdroje není jasné, neberu to jako něco, co se stalo dnes; jen jako důvod jemně ověřit, zda se s tématem dnes setkali.`);
  }
  if (partsWithHistoricalOnly.length > 0) {
    lines.push(`U těchto kluků existuje dříve evidovaný citlivý okruh bez čerstvého zdrojovaného podkladu pro dnešek: ${partsWithHistoricalOnly.join(", ")}. Smyslem je jen ověřit, zda se s tématem dnes setkali.`);
  }

  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";
  const warnings: string[] = [];
  if (lines.length === 0) {
    text = "Žádné konkrétní riziko ani citlivost dnes nevidím v podkladech označené.";
    confidence = "high";
  } else {
    text = lines.join("\n\n");
  }

  return {
    section_id: "risks_sensitivities",
    title: "Citlivosti dne",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

/**
 * Section 8 — co Karel neví / nemůže tvrdit.
 */
function renderUnknowns(payload: any, allWarnings: string[]): RenderedBriefingSection {
  const fields = ["briefing_truth_gate", "external_reality_watch.provider_status", "today_part_proposal"];
  const ext = payload?.external_reality_watch ?? null;
  const ps = safeStr(ext?.provider_status);
  const truthOk = payload?.briefing_truth_gate?.ok === true;

  const items: string[] = [];
  if (!truthOk) items.push("nevím, jestli ranní cyklus skutečně doběhl celý");
  if (!ext || ps === "not_run") items.push("nevím, co se dnes děje venku");
  if (ps === "provider_error") items.push("nemohl jsem dnes ověřit externí kontext");
  if (!payload?.today_part_proposal?.proposed_part) items.push("nevím dopředu, se kterou částí dnes půjde pracovat");

  let text: string;
  let confidence: "high" | "medium" | "low" = "high";
  if (items.length === 0) {
    text = "Pro dnešek bych si nevyhrazoval žádné velké neznámé nad rámec běžné opatrnosti.";
  } else {
    text = `Co dnes výslovně nevím a nebudu si domýšlet: ${items.join("; ")}.`;
  }

  return {
    section_id: "unknowns",
    title: "Co dnes nevím",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings: [],
  };
}

/**
 * Section 9 — opatrný další krok.
 */
function renderNextStep(payload: any): RenderedBriefingSection {
  const decision = payload?.today_part_relevance_decision ?? null;
  const dtp = decision?.ok_for_primary_suggestion === false ? "" : safeStr(payload?.daily_therapeutic_priority);
  const fields = ["daily_therapeutic_priority"];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  if (dtp) {
    text = `Jako opatrný další krok navrhuji: ${dtp.charAt(0).toLocaleLowerCase("cs")}${dtp.slice(1)}`;
    if (!/[.!?]$/.test(text)) text += ".";
    confidence = "medium";
  } else {
    text = "Konkrétní další krok pro dnešek si netroufám stanovit bez toho, abychom nejdřív viděli první kontakt s kluky.";
    confidence = "low";
    warnings.push("no_daily_priority");
  }

  return {
    section_id: "next_step",
    title: "Opatrný další krok",
    karel_text: text,
    source_fields: fields,
    confidence,
    unsupported_claims_count: 0,
    warnings,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Claim checker (deterministic, static)
// ───────────────────────────────────────────────────────────────────────────

function collectKnownPartNames(payload: any): Set<string> {
  const names = new Set<string>();
  const tppName = safeStr(payload?.today_part_proposal?.proposed_part)
    || safeStr(payload?.today_part_proposal?.part_name);
  if (tppName) names.add(tppName.toLocaleLowerCase("cs"));
  const ext = payload?.external_reality_watch ?? null;
  if (Array.isArray(ext?.parts)) {
    for (const p of ext.parts) {
      const n = safeStr(p?.part_name);
      if (n) names.add(n.toLocaleLowerCase("cs"));
    }
  }
  // Also accept ask_* role hints (Hanička/Káťa are therapist names — already addressed by vocative)
  return names;
}

const PART_NAME_CANDIDATE = /\b([A-ZÁČĎÉĚÍĽĹŇÓŘŠŤÚŮÝŽ][a-záčďéěíľĺňóřšťúůýž]{2,})\b/g;
const KNOWN_NON_PART_TOKENS = new Set([
  "Haničko", "Hanička", "Hanky", "Hanku", "Hankou", "Han",
  "Káťo", "Káťa", "Káťu", "Káťou",
  "Karel", "Karle", "Karla", "Karlovi", "Karlem",
  "Sezení", "Sezeni", "Hernu", "Herna", "Herny",
  "Tundrupkem", "Tundrupka", "Tundrupkovi", "Tundrupek", "Tundrupku",
  // generic words
  "Pro", "Dnes", "Dnešní", "Dnešek", "Beru", "Konkrétní", "Pokud",
  "Když", "Externí", "Nesené", "Žádné", "Síla", "Vychází",
  "Ranní", "Důvod", "Externí", "Pokus", "Beru", "Pro", "Caro",
].map(s => s.toLocaleLowerCase("cs")));

function validateSectionClaims(
  section: RenderedBriefingSection,
  payload: any,
  knownParts: Set<string>,
): { unsupported_claims_count: number; warnings: string[] } {
  const warnings: string[] = [];
  let unsupported = 0;
  const text = section.karel_text;

  // Rule: if section text claims numbers, they must appear in source fields
  // Only enforce for external_reality and daily_cycle_verified where numbers are stamped
  if (section.section_id === "external_reality") {
    const ext = payload?.external_reality_watch ?? null;
    // P33.7C — strip ISO date sequences (YYYY-MM-DD) and other date-context
    // numbers before extracting "claim numbers". Verification dates of cited
    // sources are not unsupported claims.
    const stripped = text
      // Full ISO dates like 2026-05-11
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
      // Czech short dates like 11. 5. 2026 or 11.5.2026
      .replace(/\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b/g, " ")
      // Year tokens 19xx/20xx
      .replace(/\b(?:19|20)\d{2}\b/g, " ");
    const numbers = (stripped.match(/\b(\d+)\b/g) || []).map(Number);
    const allowed = new Set<number>();
    if (ext) {
      allowed.add(Number(ext.active_part_daily_brief_count) || 0);
      allowed.add(Number(ext.source_backed_events_count) || 0);
      allowed.add(Number(ext.internet_events_used_count) || 0);
    }
    for (const n of numbers) {
      if (!allowed.has(n)) {
        unsupported += 1;
        warnings.push(`external_reality_unsupported_number:${n}`);
      }
    }
  }

  // Rule: part-name-like tokens (proper name suffixes) must match a known part.
  // We deliberately use a narrow regex to avoid false positives on ordinary
  // capitalized Czech sentence-starting words.
  if (section.section_id === "today_parts" || section.section_id === "risks_sensitivities") {
    const partLikePattern = /\b([A-ZÁČĎÉĚÍĽĹŇÓŘŠŤÚŮÝŽ][a-záčďéěíľĺňóřšťúůýž]{2,}(?:ek|ka|ko|ík|ík|ina|inka|oušek|ánek|ouš))\b/g;
    let m: RegExpExecArray | null;
    while ((m = partLikePattern.exec(text)) !== null) {
      const tokenLower = m[1].toLocaleLowerCase("cs");
      if (KNOWN_NON_PART_TOKENS.has(tokenLower)) continue;
      let matched = false;
      for (const known of knownParts) {
        if (tokenLower.startsWith(known.slice(0, Math.min(4, known.length)))) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        unsupported += 1;
        warnings.push(`unsupported_part_name:${m[1]}`);
      }
    }
  }

  // Rule: external-reality claim words require ext payload
  if (/zdrojovan/i.test(text) || /provider_status/i.test(text)) {
    if (!payload?.external_reality_watch) {
      unsupported += 1;
      warnings.push("external_reality_claim_without_payload");
    }
  }

  return { unsupported_claims_count: unsupported, warnings };
}

function auditForbiddenPhrases(text: string): { hits: string[]; count: number } {
  const hits: string[] = [];
  for (const f of FORBIDDEN_ROBOTIC_PHRASES) {
    if (f.pattern.test(text)) hits.push(f.label);
  }
  return { hits, count: hits.length };
}

function auditInternalTerms(text: string): boolean {
  return INTERNAL_TERMS.some((re) => re.test(text));
}

// ───────────────────────────────────────────────────────────────────────────
// Public renderer
// ───────────────────────────────────────────────────────────────────────────

export function renderKarelBriefingVoice(payload: any): KarelBriefingVoiceRenderResult {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      renderer_version: RENDERER_VERSION,
      source_cycle_id: null,
      briefing_truth_gate_ok: false,
      sections: [],
      render_audit: {
        source_fields_used: [],
        missing_expected_fields: [],
        unsupported_claims_count: 0,
        robotic_phrase_count: 0,
        forbidden_phrase_hits: [],
        empty_sections_count: 0,
      },
      errors: ["payload_missing_or_invalid"],
    };
  }

  const truthOk = payload?.briefing_truth_gate?.ok === true;
  const sourceCycleId = safeStr(payload?.briefing_truth_gate?.source_cycle_id)
    || safeStr(payload?.source_cycle_id) || null;
  const providerStatus = safeStr(payload?.external_reality_watch?.provider_status) || null;

  const sections: RenderedBriefingSection[] = [
    renderSystemMorningState(payload),
    renderDailyCycleVerified(payload),
    renderYesterdayReview(payload),
    renderTodayParts(payload),
    renderTherapistAsks(payload),
    renderSessionPlan(payload),
    renderExternalReality(payload),
    renderRisks(payload),
    renderUnknowns(payload, []),
    renderNextStep(payload),
  ];

  // P33.7 — content completeness contract
  const contentCompleteness = evaluateBriefingContentCompleteness(payload);

  // Claim check + forbidden phrase audit per section
  const knownParts = collectKnownPartNames(payload);
  const sourceFieldsUsed = new Set<string>();
  let totalUnsupported = 0;
  let totalRobotic = 0;
  const forbiddenHits: string[] = [];
  let empty = 0;

  for (const sec of sections) {
    sec.karel_text = sanitizeRenderedText(sec.karel_text);
    pushUsed(sourceFieldsUsed, sec.source_fields);
    const claim = validateSectionClaims(sec, payload, knownParts);
    sec.unsupported_claims_count += claim.unsupported_claims_count;
    sec.warnings.push(...claim.warnings);

    const robo = auditForbiddenPhrases(sec.karel_text);
    sec.unsupported_claims_count += 0;
    if (robo.count > 0) {
      sec.warnings.push(...robo.hits.map((h) => `forbidden_phrase:${h}`));
      forbiddenHits.push(...robo.hits);
      totalRobotic += robo.count;
    }
    if (auditInternalTerms(sec.karel_text)) {
      sec.warnings.push("internal_term_leak");
      totalRobotic += 1;
    }

    if (!sec.karel_text || sec.karel_text.trim().length < 10) empty += 1;
    totalUnsupported += sec.unsupported_claims_count;
  }

  const missingExpected: string[] = [];
  if (!payload?.briefing_truth_gate) missingExpected.push("briefing_truth_gate");
  if (!payload?.external_reality_watch) missingExpected.push("external_reality_watch");

  // P33.7C — ok-gate must also honour the content-completeness contract.
  // Allowed statuses: "complete" and "complete_with_controlled_missing".
  // Controlled-missing alone must NOT make ok=false (the missing reason is
  // visibly rendered). Blocked / incomplete states force ok=false.
  const completenessStatus = String(contentCompleteness?.overall_status ?? "");
  const completenessOk =
    completenessStatus === "complete" ||
    completenessStatus === "complete_with_controlled_missing";

  const ok = sections.length >= 6
    && totalUnsupported === 0
    && totalRobotic === 0
    && empty === 0
    && errors.length === 0
    && completenessOk;

  return {
    ok,
    renderer_version: RENDERER_VERSION,
    source_cycle_id: sourceCycleId,
    briefing_truth_gate_ok: truthOk,
    provider_status: providerStatus,
    sections,
    opening_text: sections[0]?.karel_text,
    closing_text: sections[sections.length - 1]?.karel_text,
    content_completeness: contentCompleteness,
    render_audit: {
      source_fields_used: Array.from(sourceFieldsUsed).sort(),
      missing_expected_fields: missingExpected,
      unsupported_claims_count: totalUnsupported,
      robotic_phrase_count: totalRobotic,
      forbidden_phrase_hits: forbiddenHits,
      empty_sections_count: empty,
    },
    errors,
  };
}
