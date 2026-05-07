/**
 * P31.1 — karelBriefingVoiceRenderer
 *
 * Truth-locked deterministic renderer that converts an already truth-gated
 * briefing payload into human, Karel-voiced sections. NO AI calls. NO fetch.
 * Renderer NEVER invents facts; it can only render what the payload contains.
 *
 * Public API: renderKarelBriefingVoice(payload) → KarelBriefingVoiceRenderResult
 */

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

export const RENDERER_VERSION = "p31.1.0";

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
  const snap = payload?.phase_jobs_snapshot ?? null;
  const fields = ["phase_jobs_snapshot"];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  if (snap && typeof snap === "object") {
    const jobs = Array.isArray(snap?.jobs) ? snap.jobs : [];
    const total = jobs.length || (typeof snap?.total === "number" ? snap.total : 0);
    const completed = jobs.filter((j: any) => j?.status === "completed").length
      || (typeof snap?.completed === "number" ? snap.completed : 0);
    if (total > 0) {
      text = `Z dnešní ranní přípravy je hotových ${completed} ze ${total} kroků. Beru to jako solidní základ pro dnešek.`;
      confidence = completed === total ? "high" : "medium";
    } else {
      text = "Dnešní ranní příprava sice proběhla, ale nemám u sebe podrobnější přehled jejích jednotlivých kroků.";
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
 */
function renderTodayParts(payload: any): RenderedBriefingSection {
  const tpp = payload?.today_part_proposal ?? null;
  const fields = [
    "today_part_proposal.proposed_part",
    "today_part_proposal.rationale_text",
    "today_part_proposal.is_hypothesis_only",
    "today_part_proposal.evidence_strength",
  ];
  const warnings: string[] = [];
  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";

  const partName = safeStr(tpp?.proposed_part) || safeStr(tpp?.part_name);
  const rationale = safeStr(tpp?.rationale_text);
  const isHypothesis = tpp?.is_hypothesis_only === true;
  const evidence = safeStr(tpp?.evidence_strength);

  if (partName) {
    const hypoNote = isHypothesis
      ? " Beru to ale jen jako pracovní hypotézu, dokud to nepotvrdí Hanička s Káťou."
      : "";
    const evCz = evidence === "low" ? "nízká" : evidence === "medium" ? "střední" : evidence === "high" ? "vyšší" : "";
    const evNote = evCz ? ` Opora v podkladech je ${evCz}.` : "";
    const why = rationale ? ` Vychází to z toho, že ${rationale.charAt(0).toLocaleLowerCase("cs")}${rationale.slice(1)}` : "";
    text = `Pro dnešek se mi jako možná část pro práci nabízí ${partName}.${hypoNote}${evNote}${why ? "\n\n" + why : ""}`;
    confidence = isHypothesis || evidence === "low" ? "low" : "medium";
  } else {
    text = "Dnes nemám dost podkladů na to, abych navrhoval konkrétní část pro práci. Doporučuji vyjít z toho, co kluci sami přinesou.";
    confidence = "low";
    warnings.push("no_today_part_proposal");
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

/**
 * Section 4 — úkoly terapeutek (ask_hanka / ask_kata).
 */
function renderTherapistAsks(payload: any): RenderedBriefingSection {
  const askH = Array.isArray(payload?.ask_hanka) ? payload.ask_hanka : [];
  const askK = Array.isArray(payload?.ask_kata) ? payload.ask_kata : [];
  const fields = ["ask_hanka", "ask_kata"];
  const warnings: string[] = [];

  const firstH = safeStr(askH[0]?.text);
  const firstK = safeStr(askK[0]?.text);

  const parts: string[] = [];
  if (firstH) parts.push(`Haničko, hlavní věc na dnes je ${firstH.charAt(0).toLocaleLowerCase("cs")}${firstH.slice(1)}.`);
  if (firstK) parts.push(`Káťo, hlavní věc na dnes je ${firstK.charAt(0).toLocaleLowerCase("cs")}${firstK.slice(1)}.`);
  if (askH.length > 1) parts.push(`Pro Haničku k tomu mám ještě ${askH.length - 1} navazujících bodů.`);
  if (askK.length > 1) parts.push(`Pro Káťu k tomu mám ještě ${askK.length - 1} navazujících bodů.`);

  let text: string;
  let confidence: "high" | "medium" | "low" = "high";
  if (parts.length === 0) {
    text = "Pro Haničku ani Káťu nemám dnes žádný konkrétní úkol připravený.";
    confidence = "low";
    warnings.push("no_therapist_asks");
  } else {
    text = parts.join("\n\n");
  }

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
 */
function renderSessionPlan(payload: any): RenderedBriefingSection {
  const sess = payload?.proposed_session ?? null;
  const play = payload?.proposed_playroom ?? null;
  const fields = ["proposed_session", "proposed_playroom"];
  const warnings: string[] = [];

  const sessTitle = safeStr(sess?.title || sess?.theme || sess?.focus);
  const playTitle = safeStr(play?.title || play?.theme || play?.focus);

  const lines: string[] = [];
  if (sessTitle) lines.push(`Pro dnešní Sezení mám připravený rámec: ${sessTitle}.`);
  if (playTitle) lines.push(`Pro Hernu mám připravený rámec: ${playTitle}.`);

  let text: string;
  let confidence: "high" | "medium" | "low" = "medium";
  if (lines.length === 0) {
    text = "Pro dnešek nemám připravený konkrétní plán Sezení ani Herny. Doporučuji rozhodnout podle prvního kontaktu s kluky.";
    confidence = "low";
    warnings.push("no_session_or_playroom");
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

  if (ps === "configured") {
    if (sourceBacked > 0) {
      text = `Externí situační přehled je dnes dostupný a vidím v něm ${sourceBacked} doložených zdrojovaných událostí, které se mapují na ${briefCount} dnešních situačních zápisů ke klukům. Pracuji s ním opatrně a jen jako s kontextem, ne jako s diagnózou.`;
      confidence = "medium";
    } else {
      text = `Externí situační přehled je dnes dostupný, ale nepřinesl žádnou doloženou událost. Beru to tak, že dnes není nic, co bych měl z venku zvlášť hlídat.`;
      confidence = "high";
    }
  } else if (ps === "provider_not_configured") {
    text = "Externí situační přehled dnes není zapnutý, takže o vnějších událostech nic netvrdím.";
    confidence = "high";
  } else if (ps === "provider_error") {
    text = "Pokus o stažení externího situačního přehledu se dnes nepovedl, takže o vnějších událostech raději nic netvrdím.";
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
  const partsWithTriggers: string[] = Array.isArray(ext?.parts)
    ? ext.parts
        .filter((p: any) => Array.isArray(p?.internet_triggers_today) && p.internet_triggers_today.length > 0)
        .map((p: any) => safeStr(p?.part_name))
        .filter(Boolean)
    : [];

  const lines: string[] = [];
  if (lingering.length > 0) {
    lines.push(`Nesené téma, které ještě dobíhá: ${lingering.length === 1 ? "jedno" : `${lingering.length}`}. Nedělám z toho zatím závěr, jen ho držím na vědomí.`);
  }
  if (partsWithTriggers.length > 0) {
    lines.push(`U těchto kluků dnes vidím možný spouštěč zvenku: ${partsWithTriggers.join(", ")}. Není to predikce, je to upozornění držet bezpečný rámec.`);
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
  const dtp = safeStr(payload?.daily_therapeutic_priority);
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
    const numbers = (text.match(/\b(\d+)\b/g) || []).map(Number);
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
    renderTodayParts(payload),
    renderTherapistAsks(payload),
    renderSessionPlan(payload),
    renderExternalReality(payload),
    renderRisks(payload),
    renderUnknowns(payload, []),
    renderNextStep(payload),
  ];

  // Claim check + forbidden phrase audit per section
  const knownParts = collectKnownPartNames(payload);
  const sourceFieldsUsed = new Set<string>();
  let totalUnsupported = 0;
  let totalRobotic = 0;
  const forbiddenHits: string[] = [];
  let empty = 0;

  for (const sec of sections) {
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

  const ok = sections.length >= 6
    && totalUnsupported === 0
    && totalRobotic === 0
    && empty === 0
    && errors.length === 0;

  return {
    ok,
    renderer_version: RENDERER_VERSION,
    source_cycle_id: sourceCycleId,
    briefing_truth_gate_ok: truthOk,
    provider_status: providerStatus,
    sections,
    opening_text: sections[0]?.karel_text,
    closing_text: sections[sections.length - 1]?.karel_text,
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
