/**
 * playroomGroundedPlan.ts — P33.11 KROK 3 (Tundrupek-grounded program)
 *
 * Builds Herna program from REAL Tundrupek data:
 *  - did_part_registry  (canonical card snapshot — triggers/strengths/role)
 *  - did_part_profiles   (additional profile fields if present)
 *  - did_active_part_daily_brief  (last 7d brief — sensitive patterns, internet/external triggers, anniversaries)
 *  - did_session_reviews (last 3 playroom session reports for this part — what worked / what destabilised)
 *  - hana_personal_memory (last 10 entries with did_relevant=true mentioning part — recent stressors)
 *
 * Calls Lovable AI (google/gemini-2.5-pro) with strict JSON schema.
 * Validates against:
 *   - required block fields
 *   - anti-template guard (rejects literal old-fallback phrases)
 *   - fake-personalization guard (rejects program with no concrete tokens from sources)
 *
 * Returns { plan, sourcesUsed, status: 'grounded' | 'fallback', reason? }.
 * Caller is responsible for fallback to hardcoded plan if status=fallback.
 *
 * ZERO side effects beyond fetch + read queries. Pure return value.
 */

// deno-lint-ignore no-explicit-any
type SB = any;

export type PlayroomContextSources = {
  registry: any | null;
  profile: any | null;
  recentBriefs: any[];
  recentSessionReviews: any[];
  recentHanaMemory: any[];
};

export type PlayroomContextSummary = {
  partName: string;
  age: string | null;
  role: string | null;
  triggers: string[];
  strengths: string[];
  recentSensitivePatterns: string[];
  recentInternetTriggers: string[];
  recentExternalEvents: string[];
  recentAnniversaries: string[];
  lastSessionsHighlights: string[];   // short bullets pulled from session_reviews
  lastSessionsDestabilisers: string[];
  recentHanaSafeSummaries: string[];  // safe summaries (private_to_hana respected — no raw text)
  /** Tokens that MUST appear somewhere in the AI output, otherwise fake_personalization. */
  groundingTokens: string[];
};

export type GatherResult = {
  sources: PlayroomContextSources;
  summary: PlayroomContextSummary;
  sourceRefs: Array<{ source: string; ref: string; ok: boolean; note?: string }>;
};

function uniqLower(arr: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const v of arr) {
    if (!v) continue;
    const t = String(v).trim();
    if (!t) continue;
    set.add(t);
  }
  return Array.from(set);
}

export async function gatherPlayroomContext(
  sb: SB,
  opts: { userId: string; partName: string; todayPrague: string },
): Promise<GatherResult> {
  const { userId, partName } = opts;
  const sourceRefs: GatherResult["sourceRefs"] = [];
  const sources: PlayroomContextSources = {
    registry: null,
    profile: null,
    recentBriefs: [],
    recentSessionReviews: [],
    recentHanaMemory: [],
  };

  // 1) registry (the operational card snapshot)
  try {
    const { data, error } = await sb.from("did_part_registry")
      .select("part_name,display_name,status,age_estimate,role_in_system,known_triggers,known_strengths,last_emotional_state,notes,next_session_plan,last_seen_at")
      .eq("user_id", userId).eq("part_name", partName).maybeSingle();
    if (error) sourceRefs.push({ source: "did_part_registry", ref: partName, ok: false, note: error.message });
    else {
      sources.registry = data ?? null;
      sourceRefs.push({ source: "did_part_registry", ref: partName, ok: !!data });
    }
  } catch (e) {
    sourceRefs.push({ source: "did_part_registry", ref: partName, ok: false, note: String(e) });
  }

  // 2) profile (optional)
  try {
    const { data } = await sb.from("did_part_profiles")
      .select("*").eq("user_id", userId).eq("part_name", partName).maybeSingle();
    sources.profile = data ?? null;
    sourceRefs.push({ source: "did_part_profiles", ref: partName, ok: !!data });
  } catch { /* optional */ }

  // 3) recent active_part_daily_brief (last 7d for this part)
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data } = await sb.from("did_active_part_daily_brief")
      .select("brief_date,activity_status,known_sensitive_patterns,internet_triggers_today,external_events_today,anniversaries_today,recommended_prevention,evidence_summary")
      .eq("user_id", userId).eq("part_name", partName).gte("brief_date", sevenDaysAgo)
      .order("brief_date", { ascending: false }).limit(7);
    sources.recentBriefs = data ?? [];
    sourceRefs.push({ source: "did_active_part_daily_brief", ref: `${partName} last7d`, ok: (data?.length ?? 0) > 0, note: `${data?.length ?? 0} rows` });
  } catch (e) {
    sourceRefs.push({ source: "did_active_part_daily_brief", ref: partName, ok: false, note: String(e) });
  }

  // 4) recent playroom session_reviews — last 3 for this part
  try {
    const { data: planRows } = await sb.from("did_daily_session_plans")
      .select("id,plan_date").eq("user_id", userId).eq("selected_part", partName)
      .order("plan_date", { ascending: false }).limit(10);
    const planIds = (planRows ?? []).map((p: any) => p.id);
    if (planIds.length > 0) {
      const { data: reviews } = await sb.from("did_session_reviews")
        .select("plan_id,analysis_json,status,created_at")
        .in("plan_id", planIds).order("created_at", { ascending: false }).limit(3);
      sources.recentSessionReviews = reviews ?? [];
      sourceRefs.push({ source: "did_session_reviews", ref: `${partName} last3`, ok: (reviews?.length ?? 0) > 0, note: `${reviews?.length ?? 0} reviews` });
    } else {
      sourceRefs.push({ source: "did_session_reviews", ref: partName, ok: false, note: "no prior plans" });
    }
  } catch (e) {
    sourceRefs.push({ source: "did_session_reviews", ref: partName, ok: false, note: String(e) });
  }

  // 5) recent Hana memory — did_relevant=true, mentioning part in safe_summary
  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await sb.from("hana_personal_memory")
      .select("memory_type,safe_summary,emotional_state,next_opening_hint,created_at")
      .eq("user_id", userId).eq("did_relevant", true).is("superseded_at", null)
      .gte("created_at", fourteenDaysAgo)
      .order("created_at", { ascending: false }).limit(20);
    const filtered = (data ?? []).filter((m: any) => {
      const s = String(m.safe_summary ?? "").toLowerCase();
      return s.includes(partName.toLowerCase());
    }).slice(0, 10);
    sources.recentHanaMemory = filtered;
    sourceRefs.push({ source: "hana_personal_memory", ref: `${partName} did_relevant 14d`, ok: filtered.length > 0, note: `${filtered.length} entries` });
  } catch (e) {
    sourceRefs.push({ source: "hana_personal_memory", ref: partName, ok: false, note: String(e) });
  }

  const summary = summarizeContext(opts.partName, sources);
  return { sources, summary, sourceRefs };
}

export function summarizeContext(partName: string, src: PlayroomContextSources): PlayroomContextSummary {
  const triggers = uniqLower([
    ...(src.registry?.known_triggers ?? []),
    ...(src.profile?.known_triggers ?? []),
  ]);
  const strengths = uniqLower([
    ...(src.registry?.known_strengths ?? []),
    ...(src.profile?.known_strengths ?? []),
  ]);

  const recentSensitivePatterns: string[] = [];
  const recentInternetTriggers: string[] = [];
  const recentExternalEvents: string[] = [];
  const recentAnniversaries: string[] = [];
  for (const b of src.recentBriefs) {
    for (const p of (b.known_sensitive_patterns ?? [])) {
      if (typeof p === "string") recentSensitivePatterns.push(p);
      else if (p?.pattern) recentSensitivePatterns.push(String(p.pattern));
      else if (p?.label) recentSensitivePatterns.push(String(p.label));
    }
    for (const t of (b.internet_triggers_today ?? [])) {
      if (typeof t === "string") recentInternetTriggers.push(t);
      else if (t?.label) recentInternetTriggers.push(String(t.label));
      else if (t?.title) recentInternetTriggers.push(String(t.title));
    }
    for (const e of (b.external_events_today ?? [])) {
      if (typeof e === "string") recentExternalEvents.push(e);
      else if (e?.label) recentExternalEvents.push(String(e.label));
      else if (e?.title) recentExternalEvents.push(String(e.title));
    }
    for (const a of (b.anniversaries_today ?? [])) {
      if (typeof a === "string") recentAnniversaries.push(a);
      else if (a?.label) recentAnniversaries.push(String(a.label));
    }
  }

  const lastSessionsHighlights: string[] = [];
  const lastSessionsDestabilisers: string[] = [];
  for (const r of src.recentSessionReviews) {
    const aj = r?.analysis_json ?? {};
    if (aj?.what_worked) lastSessionsHighlights.push(String(aj.what_worked).slice(0, 200));
    if (Array.isArray(aj?.highlights)) for (const h of aj.highlights.slice(0, 2)) lastSessionsHighlights.push(String(h).slice(0, 200));
    if (aj?.what_destabilised) lastSessionsDestabilisers.push(String(aj.what_destabilised).slice(0, 200));
    if (Array.isArray(aj?.stop_signals_observed)) for (const s of aj.stop_signals_observed.slice(0, 2)) lastSessionsDestabilisers.push(String(s).slice(0, 200));
  }

  const recentHanaSafeSummaries = src.recentHanaMemory
    .map((m: any) => String(m.safe_summary ?? "").slice(0, 240))
    .filter((s) => s);

  // Grounding tokens — concrete tokens AI must reference somewhere.
  // Lowercased, deduped, only meaningful nouns/labels (>2 chars).
  const tokenPool = uniqLower([
    ...triggers,
    ...strengths,
    ...recentSensitivePatterns,
    ...recentInternetTriggers,
    ...recentExternalEvents,
  ])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2 && !/^(ok|ano|ne|new|old)$/.test(t));

  return {
    partName,
    age: src.registry?.age_estimate ?? src.profile?.age_estimate ?? null,
    role: src.registry?.role_in_system ?? null,
    triggers,
    strengths,
    recentSensitivePatterns: uniqLower(recentSensitivePatterns),
    recentInternetTriggers: uniqLower(recentInternetTriggers),
    recentExternalEvents: uniqLower(recentExternalEvents),
    recentAnniversaries: uniqLower(recentAnniversaries),
    lastSessionsHighlights,
    lastSessionsDestabilisers,
    recentHanaSafeSummaries,
    groundingTokens: tokenPool,
  };
}

// ── Validation ────────────────────────────────────────────────────────────

export const REQUIRED_BLOCK_FIELDS = [
  "title",
  "clinical_intent",
  "hidden_diagnostic_aim",
  "play_metaphor",
  "child_facing_prompt_draft",
  "what_to_watch",
  "stop_criteria",
  "why_today",
  "why_for_this_part",
  "why_this_form_fits",
] as const;

/** Phrases that mark regression to the old hardcoded fallback. */
const ANTI_TEMPLATE_PHRASES = [
  "můžeme u toho zůstat jen krátce a bezpečně",
  "krátké klinické zmapování aktuálního tělesného a emočního stavu části",
  "neutrální bezpečná symbolická volba",
  "terapeutický význam",
  "bezpečné přivítání a volba intenzity",
  "mapování dnešního stavu",
  "hravý remote-native mikroúkol",
  "upevnění zdroje nebo hranice",
];

/** Phrases that mean child-facing text is talking like a clinician, not to a child. */
const CLINICAL_LEAK_IN_CHILD_TEXT = [
  "klinick",
  "diagnostick",
  "regulace",
  "stabilizace",
  "tolerance kontaktu",
  "projektivn",
  "symbolická volba",
];

export type PlayroomGuardResult =
  | { ok: true }
  | { ok: false; reason: "missing_required_field"; detail: string }
  | { ok: false; reason: "anti_template_hit"; detail: string }
  | { ok: false; reason: "clinical_leak_in_child_text"; detail: string }
  | { ok: false; reason: "fake_personalization"; detail: string }
  | { ok: false; reason: "weak_questions"; detail: string };

export function validateGroundedPlan(
  plan: any,
  ctx: { partName: string; groundingTokens: string[] },
): PlayroomGuardResult {
  if (!plan || typeof plan !== "object") return { ok: false, reason: "missing_required_field", detail: "plan not object" };
  const blocks = plan.therapeutic_program;
  if (!Array.isArray(blocks) || blocks.length < 3) return { ok: false, reason: "missing_required_field", detail: "therapeutic_program needs ≥3 blocks" };

  for (const [i, b] of blocks.entries()) {
    for (const f of REQUIRED_BLOCK_FIELDS) {
      const v = (b ?? {})[f];
      if (typeof v !== "string" || v.trim().length < 3) {
        return { ok: false, reason: "missing_required_field", detail: `block #${i + 1} missing/empty "${f}"` };
      }
    }
  }

  const fullJson = JSON.stringify(plan).toLowerCase();
  for (const phrase of ANTI_TEMPLATE_PHRASES) {
    if (fullJson.includes(phrase)) return { ok: false, reason: "anti_template_hit", detail: phrase };
  }

  for (const [i, b] of blocks.entries()) {
    const child = String(b.child_facing_prompt_draft ?? "").toLowerCase();
    for (const leak of CLINICAL_LEAK_IN_CHILD_TEXT) {
      if (child.includes(leak)) {
        return { ok: false, reason: "clinical_leak_in_child_text", detail: `block #${i + 1}: "${leak}"` };
      }
    }
  }

  // fake_personalization: at least 1 grounding token must appear in the program
  // (skip if there were literally no grounding tokens — then there is nothing
  //  to anchor against and we cannot blame the AI for it).
  if (ctx.groundingTokens.length > 0) {
    const hits = ctx.groundingTokens.filter((tok) => fullJson.includes(tok));
    if (hits.length === 0) {
      return { ok: false, reason: "fake_personalization", detail: `no grounding token from [${ctx.groundingTokens.slice(0, 6).join(", ")}…] present anywhere in plan` };
    }
  }

  // narrow therapist questions
  const qs = plan.therapist_questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 3) {
    return { ok: false, reason: "weak_questions", detail: "therapist_questions must have 1–3 items" };
  }
  for (const [i, q] of qs.entries()) {
    const t = typeof q === "string" ? q : String(q?.question ?? "");
    if (t.length < 10 || /\?\s*$/.test(t) === false) {
      return { ok: false, reason: "weak_questions", detail: `q#${i + 1} too short or missing '?'` };
    }
    if (/obecn|jak se má|jak je na tom|jak to vypadá/i.test(t)) {
      return { ok: false, reason: "weak_questions", detail: `q#${i + 1} too generic` };
    }
  }

  return { ok: true };
}

// ── AI call ───────────────────────────────────────────────────────────────

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function buildSystemPrompt(): string {
  return `Jsi klinický psycholog dětí a adolescentů s trénikem v psychoanalýze, somatic experiencing a hravé terapii. Tvým úkolem je navrhnout PROGRAM HERNY (Karel-led, remote, ~25 min) pro KONKRÉTNÍ část DID systému, na základě poskytnutých dat.

NESMÍŠ vyrobit obecnou šablonu, která by se hodila na jakékoli dítě.
MUSÍŠ použít konkrétní triggery, motivy, jména, témata a styl té části — z dat, ne z domyšlení.

Každý blok programu MUSÍ být zároveň:
- konkrétní hra / mikro-aktivita s jasným motivem (ne "mapování stavu")
- skrytý klinický nástroj (regulace, vztah blízkost/vzdálenost, projektivní práce, odlišení dnešního stresoru od staršího materiálu, jemné hlubinné prvky kde vhodné)

Child-facing text:
- konkrétní, živý, motivující, ale ne infantilní
- ŽÁDNÁ klinická terminologie (zákazaná slova: klinický, diagnostický, regulace, stabilizace, tolerance, projektivní)
- vzbuzuje chuť zapojit se

Otázky pro terapeutky:
- 1–3 úzké otázky, které když odpoví, MĚNÍ konkrétní blok
- ne obecné "jak to vypadá"

Vrať POUZE validní JSON (žádný markdown, žádný text okolo) podle schématu níž.`;
}

function buildSchemaInstruction(): string {
  return `JSON schéma:
{
  "title": string,                          // konkrétní název dnešní Herny (zmiňuje motiv, ne jen jméno části)
  "clinical_goal": string,                  // klinický cíl celé Herny
  "why_today": string,                      // proč právě dnes (z dat — recent triggers / sessions / hana)
  "play_through_line": string,              // sjednocující hravý oblouk celé Herny (jeden motiv, který drží program pohromadě)
  "duration_min": number,
  "data_provenance": string,                // krátká věta: z čeho jsem vycházel (registry/triggers/last_session/hana)
  "therapeutic_program": [
    {
      "step": number,
      "duration_min": number,
      "title": string,                      // KONKRÉTNÍ název bloku (ne "mapování stavu")
      "play_metaphor": string,              // hravá forma / metafora bloku
      "child_facing_prompt_draft": string,  // CO PŘESNĚ Karel řekne dítěti (živě, bez klinického jazyka)
      "clinical_intent": string,            // klinický záměr (interní)
      "hidden_diagnostic_aim": string,      // co tímto skrytě zjišťuji
      "what_to_watch": string,              // signály, které sleduju
      "stop_criteria": string,              // kdy okamžitě stop / zkrátit
      "why_today": string,                  // proč tento blok dnes
      "why_for_this_part": string,          // proč pro TUTO část (zmínit konkrétní data)
      "why_this_form_fits": string          // proč právě tato forma sedí téhle části
    }
  ],
  "therapist_questions": [string],          // 1–3 úzké otázky pro Hanku/Káťu, které mění program
  "stop_signals": [string],
  "fallback": string
}`;
}

function buildUserPrompt(summary: PlayroomContextSummary, todayPrague: string, readiness: "red" | "amber" | "green"): string {
  const lines: string[] = [];
  lines.push(`DATUM: ${todayPrague}`);
  lines.push(`ČÁST: ${summary.partName}${summary.age ? ` (věk ~${summary.age})` : ""}${summary.role ? ` — role v systému: ${summary.role}` : ""}`);
  lines.push(`READINESS DNES: ${readiness === "red" ? "RED — jen krátký bezpečný kontakt, žádné riskantní motivy" : readiness === "amber" ? "AMBER — opatrně, ale lze hrát" : "GREEN — lze plný program"}`);

  if (summary.triggers.length) lines.push(`\nZNÁMÉ TRIGGERY (z karty):\n- ${summary.triggers.join("\n- ")}`);
  if (summary.strengths.length) lines.push(`\nZNÁMÉ ZDROJE / SILNÉ STRÁNKY (z karty):\n- ${summary.strengths.join("\n- ")}`);
  if (summary.recentSensitivePatterns.length) lines.push(`\nCITLIVÉ VZORCE POSLEDNÍ TÝDEN:\n- ${summary.recentSensitivePatterns.join("\n- ")}`);
  if (summary.recentInternetTriggers.length) lines.push(`\nINTERNET / OBSAH-TRIGGERY POSLEDNÍ DNY:\n- ${summary.recentInternetTriggers.join("\n- ")}`);
  if (summary.recentExternalEvents.length) lines.push(`\nVNĚJŠÍ UDÁLOSTI POSLEDNÍ DNY:\n- ${summary.recentExternalEvents.join("\n- ")}`);
  if (summary.recentAnniversaries.length) lines.push(`\nVÝROČÍ DNES:\n- ${summary.recentAnniversaries.join("\n- ")}`);
  if (summary.lastSessionsHighlights.length) lines.push(`\nCO FUNGOVALO V POSLEDNÍCH HERNÁCH:\n- ${summary.lastSessionsHighlights.join("\n- ")}`);
  if (summary.lastSessionsDestabilisers.length) lines.push(`\nCO V POSLEDNÍCH HERNÁCH ROZHODILO / STOP SIGNÁLY:\n- ${summary.lastSessionsDestabilisers.join("\n- ")}`);
  if (summary.recentHanaSafeSummaries.length) lines.push(`\nRECENT HANA SAFE-SUMMARIES (filtr: zmiňují tuto část):\n- ${summary.recentHanaSafeSummaries.join("\n- ")}`);

  if (summary.groundingTokens.length) {
    lines.push(`\nKOTVENÍ: program MUSÍ konkrétně zapracovat alespoň jeden z těchto motivů/triggerů (jinak je odmítnut jako fake_personalization): ${summary.groundingTokens.slice(0, 12).join(", ")}`);
  }

  lines.push(`\nNAVRHNI nyní 4–6 bloků (řazené step 1..N). Vrať POUZE JSON.\n\n${buildSchemaInstruction()}`);
  return lines.join("\n");
}

export async function buildPlayroomPlanGrounded(opts: {
  sb: SB;
  userId: string;
  partName: string;
  todayPrague: string;
  readiness: "red" | "amber" | "green";
  apiKey: string | null;
  /** Optional override for tests — bypass real fetch and return this raw JSON instead. */
  __aiRawOverride?: string;
}): Promise<{
  status: "grounded" | "fallback";
  plan: any | null;
  sourcesUsed: GatherResult["sourceRefs"];
  summary: PlayroomContextSummary;
  reason?: string;
  attempts: number;
  rawAi?: string;
}> {
  const gather = await gatherPlayroomContext(opts.sb, { userId: opts.userId, partName: opts.partName, todayPrague: opts.todayPrague });
  const summary = gather.summary;

  if (!opts.apiKey && !opts.__aiRawOverride) {
    return { status: "fallback", plan: null, sourcesUsed: gather.sourceRefs, summary, reason: "no_api_key", attempts: 0 };
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt(summary, opts.todayPrague, opts.readiness);

  let attempts = 0;
  let lastReason = "";
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    let raw = "";
    try {
      if (opts.__aiRawOverride && attempt === 0) {
        raw = opts.__aiRawOverride;
      } else {
        const userExtra = attempt === 0 ? user : `${user}\n\n⚠️ PŘEDCHOZÍ POKUS BYL ODMÍTNUT: ${lastReason}. OPRAV TO. Vrať POUZE JSON.`;
        const res = await fetch(AI_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-pro",
            messages: [
              { role: "system", content: system },
              { role: "user", content: userExtra },
            ],
          }),
        });
        if (!res.ok) {
          lastReason = `ai_http_${res.status}`;
          continue;
        }
        const data = await res.json();
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      lastRaw = raw;
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      let parsed: any;
      try { parsed = JSON.parse(cleaned); }
      catch (e) { lastReason = `json_parse_failed: ${(e as Error).message}`; continue; }

      const guard = validateGroundedPlan(parsed, { partName: opts.partName, groundingTokens: summary.groundingTokens });
      if (!guard.ok) {
        lastReason = `${guard.reason}: ${guard.detail}`;
        continue;
      }

      // Decorate plan with provenance + meta
      parsed.version = "playroom_plan_grounded_v1";
      parsed.part_name = opts.partName;
      parsed.date = opts.todayPrague;
      parsed.readiness_today = opts.readiness;
      parsed.meta = {
        source_status: "grounded",
        sources_used: gather.sourceRefs,
        grounding_tokens_available: summary.groundingTokens,
        generator: "playroomGroundedPlan@v1",
      };
      return { status: "grounded", plan: parsed, sourcesUsed: gather.sourceRefs, summary, attempts, rawAi: raw };
    } catch (e) {
      lastReason = `exception: ${(e as Error).message}`;
    }
  }

  return { status: "fallback", plan: null, sourcesUsed: gather.sourceRefs, summary, reason: lastReason, attempts, rawAi: lastRaw };
}
