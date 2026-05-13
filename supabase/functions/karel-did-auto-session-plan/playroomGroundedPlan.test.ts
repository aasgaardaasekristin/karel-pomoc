import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  validateGroundedPlan,
  summarizeContext,
  buildPlayroomPlanGrounded,
  REQUIRED_BLOCK_FIELDS,
} from "./playroomGroundedPlan.ts";

const FULL_BLOCK = (overrides: Record<string, any> = {}) => ({
  step: 1,
  duration_min: 5,
  title: "Mapa Tibetu — kde dnes stojím",
  play_metaphor: "Karel a Tundrupek mají rozloženou imaginární mapu Tibetu, na ní hledají dnešní stanoviště.",
  child_facing_prompt_draft: "Tundrupku, mám tu rozloženou mapu Tibetu — kdyby tvůj dnešek byl jedno místo na té mapě, kde bys teď byl? Údolí, hřeben, jeskyně, nebo úplně jinde?",
  clinical_intent: "mapování dostupnosti a aktuální emoční polohy přes prostorovou metaforu",
  hidden_diagnostic_aim: "zjistit polohu mezi izolací a kontaktem bez přímé otázky",
  what_to_watch: "volba místa, latence odpovědi, zda zvolí společnou nebo solo lokaci",
  stop_criteria: "pokud Tundrupek řekne nechci nebo se odmlčí déle než 30s",
  why_today: "po včerejším Timmy triggeru je třeba nejdřív zjistit polohu, ne tlačit",
  why_for_this_part: "Tundrupek dlouhodobě reaguje na motiv Tibetu jako na bezpečné kotvení",
  why_this_form_fits: "prostorová metafora dává Tundrupkovi kontrolu a nevynucuje verbální emoci",
  ...overrides,
});

const FULL_PLAN = (overrides: any = {}) => ({
  title: "Herna na dnes — výprava po stopách Tibetu",
  clinical_goal: "Bezpečně zjistit dopad včerejšího Timmy triggeru, otevřít prostor pro motiv ochrany.",
  why_today: "Včera v Herně přišel Timmy trigger a Tundrupek se uzavřel.",
  play_through_line: "Putování po Tibetu — každá zastávka je jeden mikro-blok.",
  duration_min: 25,
  data_provenance: "registry triggers (timmy, internet), last session_review (uzavření po Timmy)",
  therapeutic_program: [FULL_BLOCK({ step: 1 }), FULL_BLOCK({ step: 2, title: "Strážce na hřebeni" }), FULL_BLOCK({ step: 3, title: "Dračí pero — co dnes nepustím" })],
  therapist_questions: [
    "Byl od včerejška znovu kontakt s Timmy nebo příbuzným obsahem?",
    "Jak Tundrupek včera spal po té Herně?",
  ],
  stop_signals: ["nechci", "stop", "ticho déle než 30s"],
  fallback: "Zkrátit na první blok, jen mapa, ostatní vynechat.",
  ...overrides,
});

Deno.test("validateGroundedPlan: full plan passes", () => {
  const r = validateGroundedPlan(FULL_PLAN(), { partName: "Tundrupek", groundingTokens: ["timmy", "tibet"] });
  assert(r.ok, JSON.stringify(r));
});

Deno.test("validateGroundedPlan: missing required field rejected", () => {
  const plan = FULL_PLAN();
  delete (plan.therapeutic_program[1] as any).hidden_diagnostic_aim;
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "missing_required_field");
});

Deno.test("validateGroundedPlan: anti-template phrase rejected", () => {
  const plan = FULL_PLAN();
  plan.therapeutic_program[0].title = "Bezpečné přivítání a volba intenzity";
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "anti_template_hit");
});

Deno.test("validateGroundedPlan: clinical leak in child text rejected", () => {
  const plan = FULL_PLAN();
  plan.therapeutic_program[0].child_facing_prompt_draft = "Tundrupku, uděláme klinické zmapování stavu.";
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "clinical_leak_in_child_text");
});

Deno.test("validateGroundedPlan: fake personalization rejected when grounding tokens absent from plan", () => {
  const plan = FULL_PLAN();
  // strip every Tibet/Timmy mention
  for (const b of plan.therapeutic_program) {
    b.title = "Hra s kamínky";
    b.play_metaphor = "obecná hra";
    b.child_facing_prompt_draft = "Pojď si hrát s kamínky, vyber jeden.";
    b.why_for_this_part = "obecná část";
    b.why_today = "obecný den";
    b.why_this_form_fits = "obecně sedí";
    b.clinical_intent = "obecné mapování";
    b.hidden_diagnostic_aim = "obecný cíl";
    b.what_to_watch = "obecné signály";
    b.stop_criteria = "obecné stop";
  }
  plan.title = "Obecná hra";
  plan.clinical_goal = "obecný cíl";
  plan.why_today = "obecný den";
  plan.play_through_line = "obecná hra";
  plan.data_provenance = "obecné";
  plan.therapist_questions = ["Změnil se kontakt s rodinou v posledních 24h?", "Spal v noci celistvě nebo s probouzením?"];
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy", "tibet", "drak"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "fake_personalization");
});

Deno.test("validateGroundedPlan: weak generic therapist questions rejected", () => {
  const plan = FULL_PLAN();
  plan.therapist_questions = ["Jak to vypadá?"];
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: [] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "weak_questions");
});

Deno.test("summarizeContext: collects triggers + recent patterns into grounding tokens", () => {
  const sum = summarizeContext("Tundrupek", {
    registry: { age_estimate: "8", role_in_system: "child", known_triggers: ["Timmy", "internet"], known_strengths: ["Tibet", "draci"] },
    profile: null,
    recentBriefs: [{ known_sensitive_patterns: ["odmítnutí"], internet_triggers_today: [{ label: "Timmy video" }], external_events_today: [], anniversaries_today: [] }],
    recentSessionReviews: [],
    recentHanaMemory: [],
  });
  assert(sum.groundingTokens.includes("timmy"));
  assert(sum.groundingTokens.includes("tibet"));
});

// ── End-to-end with __aiRawOverride (no real AI call) ──

const fakeSb = (overrides: Record<string, any> = {}) => {
  const tables: Record<string, any> = {
    did_part_registry: { part_name: "Tundrupek", age_estimate: "8", role_in_system: "dítě", known_triggers: ["Timmy", "spánek"], known_strengths: ["Tibet", "draci"], status: "active" },
    did_part_profiles: null,
    did_active_part_daily_brief: [],
    did_daily_session_plans: [],
    did_session_reviews: [],
    hana_personal_memory: [],
    ...overrides,
  };
  const builder = (table: string) => {
    const data = tables[table];
    const chain: any = {
      _table: table,
      select: () => chain, eq: () => chain, gte: () => chain, in: () => chain,
      is: () => chain, order: () => chain, limit: () => Promise.resolve({ data: Array.isArray(data) ? data : (data ? [data] : []), error: null }),
      maybeSingle: () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data, error: null }),
    };
    return chain;
  };
  return { from: builder };
};

Deno.test("buildPlayroomPlanGrounded: returns grounded when AI override is valid plan", async () => {
  const out = await buildPlayroomPlanGrounded({
    sb: fakeSb(), userId: "u1", partName: "Tundrupek", todayPrague: "2026-05-13",
    readiness: "amber", apiKey: "fake",
    __aiRawOverride: JSON.stringify(FULL_PLAN()),
  });
  assertEquals(out.status, "grounded");
  assert(out.plan?.meta?.source_status === "grounded");
  assert(Array.isArray(out.plan?.therapeutic_program) && out.plan.therapeutic_program.length >= 3);
});

Deno.test("buildPlayroomPlanGrounded: falls back when AI override violates anti-template guard", async () => {
  const bad = FULL_PLAN();
  bad.therapeutic_program[0].title = "Bezpečné přivítání a volba intenzity";
  const out = await buildPlayroomPlanGrounded({
    sb: fakeSb(), userId: "u1", partName: "Tundrupek", todayPrague: "2026-05-13",
    readiness: "amber", apiKey: "fake",
    __aiRawOverride: JSON.stringify(bad),
  });
  assertEquals(out.status, "fallback");
  assert(out.attempts >= 1, `expected ≥1 attempt, got ${out.attempts}`);
});

Deno.test("buildPlayroomPlanGrounded: no api key → fallback (no AI call)", async () => {
  const out = await buildPlayroomPlanGrounded({
    sb: fakeSb(), userId: "u1", partName: "Tundrupek", todayPrague: "2026-05-13",
    readiness: "amber", apiKey: null,
  });
  assertEquals(out.status, "fallback");
  assertEquals(out.reason, "no_api_key");
});

Deno.test("REQUIRED_BLOCK_FIELDS contains the 10 required keys", () => {
  assertEquals(REQUIRED_BLOCK_FIELDS.length, 10);
});

// ── P33.11 KROK 3 — conditions A, B, C ──

Deno.test("A: fake_personalization — only 1 hit total is rejected", () => {
  const plan = FULL_PLAN();
  // strip Tibet from everywhere; keep exactly 1 Timmy mention in why_today
  for (const b of plan.therapeutic_program) {
    b.title = "Hra s kamínky";
    b.play_metaphor = "obecná hra";
    b.child_facing_prompt_draft = "Pojď si hrát s kamínky.";
    b.why_for_this_part = "obecná část";
    b.why_today = "obecný den";
    b.why_this_form_fits = "obecně sedí";
    b.clinical_intent = "obecné";
    b.hidden_diagnostic_aim = "obecný cíl";
    b.what_to_watch = "obecné signály";
    b.stop_criteria = "obecné stop";
  }
  plan.title = "Obecná hra";
  plan.clinical_goal = "obecné";
  plan.why_today = "Timmy"; // jediný hit
  plan.play_through_line = "obecné";
  plan.data_provenance = "obecné";
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy", "tibet", "drak"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "fake_personalization");
});

Deno.test("A: fake_personalization — 2 hits but none in key fields is rejected", () => {
  const plan = FULL_PLAN();
  for (const b of plan.therapeutic_program) {
    b.title = "Hra s kamínky";
    b.play_metaphor = "obecná hra";
    b.child_facing_prompt_draft = "Pojď si hrát s kamínky.";
    b.why_for_this_part = "obecná část";
    b.why_today = "obecný den";
    b.why_this_form_fits = "obecně sedí";
    b.clinical_intent = "obecné";
    b.hidden_diagnostic_aim = "obecný cíl";
    b.what_to_watch = "obecné signály";
    b.stop_criteria = "obecné stop";
  }
  // 2 hity ale jen v meta polích planu, ne v blocích
  plan.title = "Obecné";
  plan.clinical_goal = "Timmy a tibet kontext";
  plan.why_today = "Timmy a tibet kontext";
  plan.play_through_line = "obecné";
  plan.data_provenance = "obecné";
  const r = validateGroundedPlan(plan, { partName: "Tundrupek", groundingTokens: ["timmy", "tibet"] });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "fake_personalization");
});

Deno.test("B: empty groundingTokens → status=weakly_grounded, data_sufficiency=low", async () => {
  const out = await buildPlayroomPlanGrounded({
    sb: fakeSb({ did_part_registry: { part_name: "Tundrupek", known_triggers: [], known_strengths: [] } }),
    userId: "u1", partName: "Tundrupek", todayPrague: "2026-05-13",
    readiness: "amber", apiKey: "fake",
    __aiRawOverride: JSON.stringify(FULL_PLAN()),
  });
  assertEquals(out.status, "weakly_grounded");
  assertEquals(out.plan?.meta?.source_status, "weakly_grounded");
  assertEquals(out.plan?.meta?.data_sufficiency, "low");
});

Deno.test("C: each block carries provenance with which_sources_used + grounding_hits", async () => {
  const out = await buildPlayroomPlanGrounded({
    sb: fakeSb(), userId: "u1", partName: "Tundrupek", todayPrague: "2026-05-13",
    readiness: "amber", apiKey: "fake",
    __aiRawOverride: JSON.stringify(FULL_PLAN()),
  });
  assertEquals(out.status, "grounded");
  for (const b of out.plan!.therapeutic_program) {
    assert(Array.isArray(b.provenance?.which_sources_used), "missing which_sources_used");
    assert(Array.isArray(b.provenance?.grounding_hits), "missing grounding_hits");
    assert(typeof b.provenance?.derived_from === "string" && b.provenance.derived_from.length > 0);
    assert(b.provenance.which_sources_used.includes("registry"), "registry should be used");
  }
});
