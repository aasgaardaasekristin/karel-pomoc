import { assertEquals, assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  KAREL_PERSONA_LAYER_HANA_PERSONAL,
  buildHanaDeepContextBlocks,
  isGenericOpening,
  selectOpeningStrategy,
} from "./hanaPersonaLayer.ts";

const continuityMem = {
  id: "mem-cont-1",
  memory_type: "hana_emotional_state",
  payload: {
    emotional_signature: ["vina", "tíha"],
    dominant_themes: ["Tundrup Veliký", "K.G./Gustav"],
    unresolved_inner_conflict: "vina za regres",
    protective_need: "držení",
    relational_need: "Karel zůstává blízko",
    what_not_to_say: ["Nezačínat úředně: 'objevilo se téma kolem části…'"],
    what_to_approach_gently: ["Nejprve přítomnost."],
    opening_strategy: "warm_presence_then_gentle_bridge",
    conversation_arc_suggestion: "začít přítomností",
    opening_candidates: {
      very_soft: "Haničko, jsem tady. Jak se ti dnes dýchá?",
      direct_but_warm: "Haničko, včera se v tobě ozvala vina kolem Tundrupa.",
      if_she_seems_avoidant: "Nemusíme se k tomu vracet hned.",
    },
    visibility: "hana_only",
    do_not_export_to_did: true,
  },
};

const sharedMem = {
  id: "mem-shared-1",
  memory_type: "shared_relational_memory_candidate",
  payload: {
    visibility: "hana_only",
    never_export_to_did: true,
    never_external_fact: true,
    symbolic_anchor: "Karel jako přítomná opora",
    emotional_meaning: "nebýt sama s vinou",
    safe_phrase_karel_may_use: "Nechci tě v tom nechávat samotnou.",
    when_to_use: "Pouze v Hana/osobní",
    when_not_to_use: "Nikdy v DID/kluci",
  },
};

Deno.test("isGenericOpening flags generic 'téma kolem části' phrase", () => {
  assert(isGenericOpening("Haničko, ve včerejším osobním rozhovoru se objevilo téma kolem části Tundrupek."));
  assertFalse(isGenericOpening("Haničko, jsem tady. Jak se ti dnes dýchá?"));
});

Deno.test("selectOpeningStrategy picks very_soft for short neutral input", () => {
  const sel = selectOpeningStrategy("Dobré ráno, Lásko.", continuityMem.payload.opening_candidates);
  assertEquals(sel?.strategy, "very_soft");
  assert(sel?.candidate.includes("jsem tady"));
});

Deno.test("selectOpeningStrategy picks direct_but_warm when guilt is mentioned", () => {
  const sel = selectOpeningStrategy("Pořád cítím tu vinu kolem Tundrupa a Gustava.", continuityMem.payload.opening_candidates);
  assertEquals(sel?.strategy, "direct_but_warm");
});

Deno.test("selectOpeningStrategy picks avoidant variant when user changes topic", () => {
  const sel = selectOpeningStrategy("Pojďme o něčem jiném.", continuityMem.payload.opening_candidates);
  assertEquals(sel?.strategy, "if_she_seems_avoidant");
});

Deno.test("buildHanaDeepContextBlocks emits all required prompt blocks", () => {
  const out = buildHanaDeepContextBlocks({
    memories: [continuityMem, sharedMem],
    firstUserMessage: "Dobré ráno, Lásko",
  });
  assert(out.text.includes("KAREL_HANA_EMOTIONAL_CONTINUITY"));
  assert(out.text.includes("WHAT_NOT_TO_SAY"));
  assert(out.text.includes("WHAT_TO_APPROACH_GENTLY"));
  assert(out.text.includes("KAREL_NEXT_OPENING_STRATEGY"));
  assert(out.text.includes("KAREL_SHARED_RELATIONAL_MEMORY_HANA_ONLY"));
  assert(out.text.includes("never_export_to_did: true"));
  assertEquals(out.loaded_memory_ids.length, 2);
  assertEquals(out.has_shared_relational, true);
  assertEquals(out.opening_selection?.strategy, "very_soft");
});

Deno.test("opening candidate is never the generic 'téma kolem části' phrase", () => {
  const out = buildHanaDeepContextBlocks({ memories: [continuityMem], firstUserMessage: "Ahoj" });
  assertFalse(isGenericOpening(out.opening_selection?.candidate || ""));
});

Deno.test("Persona layer prompt forbids fake Jung quotes and bureaucratic openings", () => {
  assert(KAREL_PERSONA_LAYER_HANA_PERSONAL.includes("Jako Jung bych řekl"));
  assert(KAREL_PERSONA_LAYER_HANA_PERSONAL.includes("ZAKÁZANÉ"));
  assert(KAREL_PERSONA_LAYER_HANA_PERSONAL.includes("objevilo se téma kolem části"));
});

Deno.test("opening candidate does not contain raw intimate text", () => {
  const out = buildHanaDeepContextBlocks({ memories: [continuityMem], firstUserMessage: "Ahoj" });
  const candidate = out.opening_selection?.candidate || "";
  // raw intimate text would be transcribed message excerpts; candidates are pre-curated phrases only
  assertFalse(/sex|nah[áa]|intim|t[ěe]lo na t[ěe]le/i.test(candidate));
});
