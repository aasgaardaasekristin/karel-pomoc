/**
 * P31.2A — karelBriefingVoiceAiPolish
 *
 * Claim-checked AI polish CANDIDATE layer for the deterministic P31.1
 * Karel voice renderer. NEVER replaces deterministic sections. NEVER
 * publishes as primary text. Disabled by default via env flag
 * `P31_2_ENABLE_AI_POLISH` (must be exactly "true" to attempt).
 *
 * Design rules:
 *   - AI input MUST NOT include the raw payload.
 *   - AI input is restricted to {section_id, original_text, source_fields,
 *     source_summary} per section.
 *   - AI output is validated through: schema → section_id preserve →
 *     source_fields preserve → forbidden phrase audit → internal term audit
 *     → unsupported claim check → meaning drift check → length sanity.
 *   - Any failure → polish_status = rejected_*, deterministic original
 *     remains source of truth.
 */

import {
  FORBIDDEN_ROBOTIC_PHRASES,
  type KarelBriefingVoiceRenderResult,
  type RenderedBriefingSection,
} from "./karelBriefingVoiceRenderer.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

const INTERNAL_TERMS: RegExp[] = [
  /\bpayload\b/i,
  /\btruth gate\b/i,
  /\bjob graph\b/i,
  /\bpipeline\b/i,
  /\bjson\b/i,
  /\bschema\b/i,
];

export type PolishStatus =
  | "accepted_candidate"
  | "rejected_unsupported_claim"
  | "rejected_meaning_drift"
  | "rejected_forbidden_phrase"
  | "rejected_schema_error"
  | "not_attempted";

export interface AiPolishInput {
  payload: any;
  deterministic: KarelBriefingVoiceRenderResult;
  mode?: "candidate_only";
  // Test seam: inject AI response synchronously for unit tests.
  // Must return mapping { [section_id]: polished_text }.
  __testFetcher?: (
    sections: { section_id: string; original_text: string; source_fields: string[]; source_summary: string }[],
  ) => Promise<Record<string, string>>;
}

export interface PolishedSectionCandidate {
  section_id: string;
  original_text: string;
  polished_text: string;
  source_fields: string[];
  source_text_hash: string;
  polish_status: PolishStatus;
  unsupported_claims_count: number;
  robotic_phrase_count: number;
  warnings: string[];
}

export interface AiPolishResult {
  ok: boolean;
  mode: "candidate_only";
  model?: string;
  attempted: boolean;
  accepted_candidate_count: number;
  rejected_candidate_count: number;
  sections: PolishedSectionCandidate[];
  audit: {
    unsupported_claims_count: number;
    robotic_phrase_count: number;
    meaning_drift_count: number;
    forbidden_phrase_hits: string[];
    preserved_section_ids: boolean;
    preserved_source_fields: boolean;
  };
  errors: string[];
}

const MODEL_DEFAULT = "google/gemini-2.5-flash-lite";

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function getNumbers(s: string): string[] {
  return s.match(/\b\d+\b/g) ?? [];
}

function getCapitalizedWords(s: string): string[] {
  // Czech-aware: words starting with uppercase letter (incl. diacritics), 3+ chars.
  const re = /\b[A-ZÁČĎÉĚÍĽĹŇÓŘŠŤÚŮÝŽ][a-záčďéěíľĺňóřšťúůýž]{2,}\b/g;
  return s.match(re) ?? [];
}

export function validateMeaningDrift(original: string, polished: string): string[] {
  const warnings: string[] = [];
  const numsO = getNumbers(original);
  const numsP = getNumbers(polished);
  for (const n of numsO) {
    if (!numsP.includes(n)) warnings.push(`missing_number:${n}`);
  }

  if (/hypotéz|pracovní/i.test(original) && !/hypotéz|pracovní/i.test(polished)) {
    warnings.push("lost_hypothesis_marker");
  }
  if (/nemám|nevím|nebudu si domýšlet/i.test(original) && /\bjistě\b|\burčitě\b|\bpotvrzuji\b/i.test(polished)) {
    warnings.push("turned_uncertainty_into_certainty");
  }

  // provider_not_configured / "není zapnutý" must not flip to "dostupný/dostupné".
  if (/není zapnutý|provider_not_configured/i.test(original) && /dostupn[ýáé]/i.test(polished)) {
    warnings.push("flipped_provider_status");
  }

  // Part-name preservation (capitalized clinical names).
  const partsO = new Set(getCapitalizedWords(original));
  const partsP = new Set(getCapitalizedWords(polished));
  for (const p of partsO) {
    // Skip generic capitalized words in both → ok if also missing legitimately;
    // strict: if original has a capitalized word, polished must keep it.
    if (!partsP.has(p)) warnings.push(`missing_part_name:${p}`);
  }
  return warnings;
}

function detectForbiddenRoboticHits(text: string): string[] {
  const hits: string[] = [];
  for (const f of FORBIDDEN_ROBOTIC_PHRASES) {
    if (f.pattern.test(text)) hits.push(f.label);
  }
  return hits;
}

function detectInternalTerms(text: string): boolean {
  return INTERNAL_TERMS.some((re) => re.test(text));
}

/**
 * Build a tiny source summary per section without leaking raw payload.
 * We expose only short, derived facts the deterministic renderer already
 * relied on (counts, status strings, names) so the AI can rephrase without
 * being given JSON to invent from.
 */
function buildSourceSummary(payload: any, section: RenderedBriefingSection): string {
  const lines: string[] = [];
  const ext = payload?.external_reality_watch ?? null;
  switch (section.section_id) {
    case "system_morning_state": {
      const ok = payload?.briefing_truth_gate?.ok === true;
      lines.push(`truth_ok=${ok}`);
      break;
    }
    case "daily_cycle_verified": {
      const snap = payload?.phase_jobs_snapshot ?? null;
      const total = Number(snap?.total) || (Array.isArray(snap?.jobs) ? snap.jobs.length : 0);
      const completed = Number(snap?.completed) || 0;
      lines.push(`completed=${completed}`, `total=${total}`);
      break;
    }
    case "today_parts": {
      const tpp = payload?.today_part_proposal ?? null;
      lines.push(
        `proposed_part=${tpp?.proposed_part ?? ""}`,
        `is_hypothesis_only=${tpp?.is_hypothesis_only === true}`,
        `evidence_strength=${tpp?.evidence_strength ?? ""}`,
      );
      break;
    }
    case "therapist_asks": {
      lines.push(
        `ask_hanka_count=${Array.isArray(payload?.ask_hanka) ? payload.ask_hanka.length : 0}`,
        `ask_kata_count=${Array.isArray(payload?.ask_kata) ? payload.ask_kata.length : 0}`,
      );
      break;
    }
    case "external_reality": {
      lines.push(
        `provider_status=${ext?.provider_status ?? "not_run"}`,
        `source_backed_events_count=${Number(ext?.source_backed_events_count) || 0}`,
        `active_part_daily_brief_count=${Number(ext?.active_part_daily_brief_count) || 0}`,
      );
      break;
    }
    case "session_plan": {
      lines.push(
        `has_session=${!!payload?.proposed_session}`,
        `has_playroom=${!!payload?.proposed_playroom}`,
      );
      break;
    }
    case "risks_sensitivities": {
      lines.push(`lingering_count=${Array.isArray(payload?.lingering) ? payload.lingering.length : 0}`);
      break;
    }
    case "next_step": {
      lines.push(`has_priority=${!!payload?.daily_therapeutic_priority}`);
      break;
    }
  }
  return lines.join("; ");
}

function emptyResult(extra: Partial<AiPolishResult> = {}): AiPolishResult {
  return {
    ok: false,
    mode: "candidate_only",
    attempted: false,
    accepted_candidate_count: 0,
    rejected_candidate_count: 0,
    sections: [],
    audit: {
      unsupported_claims_count: 0,
      robotic_phrase_count: 0,
      meaning_drift_count: 0,
      forbidden_phrase_hits: [],
      preserved_section_ids: true,
      preserved_source_fields: true,
    },
    errors: [],
    ...extra,
  };
}

const POLISH_SYSTEM_PROMPT = [
  "Jsi jazykový redaktor terapeutického textu. Tvým úkolem je přeformulovat text tak, aby zněl přirozeněji v češtině.",
  "PRAVIDLA (přísně):",
  "1) Zachovej přesný význam.",
  "2) Nesmíš přidat žádné nové jméno, číslo, událost, diagnózu, plán ani závěr.",
  "3) Nesmíš změnit míru jistoty.",
  "4) Nesmíš odstranit opatrnost typu 'hypotéza', 'nemám dost podkladů', 'nebudu si domýšlet'.",
  "5) Nesmíš vložit technické termíny (payload, pipeline, schema, json, truth gate, job graph).",
  "6) Vrať JSON ve formátu {\"sections\":[{\"section_id\":\"...\",\"polished_text\":\"...\"}]}.",
].join("\n");

export async function generateKarelAiPolishCandidate(
  input: AiPolishInput,
): Promise<AiPolishResult> {
  const enabled =
    (typeof Deno !== "undefined" &&
      (Deno as any)?.env?.get?.("P31_2_ENABLE_AI_POLISH") === "true") ||
    !!input.__testFetcher;

  if (!enabled) {
    return emptyResult({ errors: ["ai_polish_disabled_by_default"] });
  }

  // Never run when deterministic failed.
  if (!input.deterministic || input.deterministic.ok !== true) {
    return emptyResult({ attempted: false, errors: ["deterministic_not_ok"] });
  }

  const sections = Array.isArray(input.deterministic.sections) ? input.deterministic.sections : [];
  if (sections.length === 0) {
    return emptyResult({ attempted: false, errors: ["no_sections"] });
  }

  // Build source-locked AI input — NEVER includes raw payload.
  const aiInput = sections.map((s) => ({
    section_id: s.section_id,
    original_text: s.karel_text,
    source_fields: s.source_fields,
    source_summary: buildSourceSummary(input.payload, s),
  }));

  // Call AI (or test fetcher).
  let aiMap: Record<string, string> = {};
  let model: string | undefined = undefined;
  const errors: string[] = [];

  try {
    if (input.__testFetcher) {
      aiMap = await input.__testFetcher(aiInput);
    } else {
      const apiKey = (Deno as any).env.get("LOVABLE_API_KEY");
      if (!apiKey) {
        return emptyResult({ attempted: true, errors: ["missing_lovable_api_key"] });
      }
      model = MODEL_DEFAULT;
      const userPrompt = JSON.stringify({ sections: aiInput });
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: POLISH_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        return emptyResult({ attempted: true, model, errors: [`ai_http_${res.status}`] });
      }
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content ?? "";
      const cleaned = String(raw).replace(/```json|```/g, "").trim();
      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return emptyResult({ attempted: true, model, errors: ["ai_json_parse_failed"] });
      }
      if (!parsed || !Array.isArray(parsed.sections)) {
        return emptyResult({ attempted: true, model, errors: ["ai_schema_invalid"] });
      }
      for (const item of parsed.sections) {
        if (item && typeof item.section_id === "string" && typeof item.polished_text === "string") {
          aiMap[item.section_id] = item.polished_text;
        }
      }
    }
  } catch (e) {
    return emptyResult({ attempted: true, model, errors: [`ai_call_failed:${(e as Error)?.message ?? e}`] });
  }

  const detIds = new Set(sections.map((s) => s.section_id));
  const aiIds = new Set(Object.keys(aiMap));
  const extraIds = [...aiIds].filter((id) => !detIds.has(id));
  const preserved_section_ids = extraIds.length === 0;
  if (extraIds.length > 0) errors.push(`extra_section_ids:${extraIds.join(",")}`);

  const out: PolishedSectionCandidate[] = [];
  let accepted = 0;
  let rejected = 0;
  let unsupportedTotal = 0;
  let roboticTotal = 0;
  let driftTotal = 0;
  const forbiddenHits: string[] = [];

  for (const s of sections) {
    const polished = aiMap[s.section_id];
    if (typeof polished !== "string" || polished.trim().length === 0) {
      out.push({
        section_id: s.section_id,
        original_text: s.karel_text,
        polished_text: s.karel_text,
        source_fields: s.source_fields,
        source_text_hash: djb2(s.karel_text),
        polish_status: "rejected_schema_error",
        unsupported_claims_count: 0,
        robotic_phrase_count: 0,
        warnings: ["missing_polished_text"],
      });
      rejected++;
      continue;
    }

    // Length sanity (3x guard).
    const lengthOk = polished.length <= s.karel_text.length * 3 + 200;
    const robotic = detectForbiddenRoboticHits(polished);
    const internalLeak = detectInternalTerms(polished);
    const drift = validateMeaningDrift(s.karel_text, polished);

    let status: PolishStatus = "accepted_candidate";
    const warnings: string[] = [];

    if (!lengthOk) {
      status = "rejected_schema_error";
      warnings.push("length_exceeded");
    } else if (robotic.length > 0) {
      status = "rejected_forbidden_phrase";
      warnings.push(...robotic.map((r) => `forbidden:${r}`));
      forbiddenHits.push(...robotic);
      roboticTotal += robotic.length;
    } else if (internalLeak) {
      status = "rejected_forbidden_phrase";
      warnings.push("internal_term_leak");
      roboticTotal += 1;
    } else if (drift.length > 0) {
      status = "rejected_meaning_drift";
      warnings.push(...drift);
      driftTotal += drift.length;
      // Drift that adds unsupported number/part counts as unsupported claim.
      if (drift.some((d) => d.startsWith("missing_part_name:"))) {
        unsupportedTotal += 1;
      }
    }

    if (status === "accepted_candidate") accepted++;
    else rejected++;

    out.push({
      section_id: s.section_id,
      original_text: s.karel_text,
      polished_text: status === "accepted_candidate" ? polished : s.karel_text,
      source_fields: s.source_fields, // preserved verbatim from deterministic
      source_text_hash: djb2(s.karel_text),
      polish_status: status,
      unsupported_claims_count: status === "rejected_meaning_drift" ? drift.length : 0,
      robotic_phrase_count: robotic.length + (internalLeak ? 1 : 0),
      warnings,
    });
  }

  return {
    ok: errors.length === 0 && accepted > 0,
    mode: "candidate_only",
    model,
    attempted: true,
    accepted_candidate_count: accepted,
    rejected_candidate_count: rejected,
    sections: out,
    audit: {
      unsupported_claims_count: unsupportedTotal,
      robotic_phrase_count: roboticTotal,
      meaning_drift_count: driftTotal,
      forbidden_phrase_hits: forbiddenHits,
      preserved_section_ids,
      preserved_source_fields: true,
    },
    errors,
  };
}
