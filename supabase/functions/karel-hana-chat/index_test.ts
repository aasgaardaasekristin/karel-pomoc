import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { guardHanaPersonalResponse } from "../_shared/hanaPersonalGuards.ts";
import { classifyDidRelevance, normalizeEvent } from "../_shared/didEventIngestion.ts";

Deno.test("Hana/Osobní real-world response guard replaces overinterpretation", () => {
  const input = "Děti sledují záchrannou akci Timmiho, keporkaka. Je to skutečné zvíře a aktuální situace.";
  const badOutput = "Timmi se pro ně stává symbolem a je symbol zranitelných částí. Jednoznačně ukazuje hluboký signál.";
  const guarded = guardHanaPersonalResponse(badOutput, input, "2026-04-29");

  assertEquals(guarded.replaced, true);
  assertEquals(/DENNÍ BRIEFING|2\. května|diagnostick[ýy] sign[áa]l|projekce|symbol|symbolizuje|ztělesňuje|ztělesnění|vysvětluje|jednoznačně ukazuje/i.test(guarded.text), false);
  assertStringIncludes(guarded.text, "skutečná aktuální situace");
  assertStringIncludes(guarded.text, "emoční kontext");
  assertStringIncludes(guarded.text, "bez závěru bez vlastní reakce kluků");
  assertStringIncludes(guarded.text, "co o té situaci sami říkají");
  assertStringIncludes(guarded.text, "co cítí v těle");
  assertStringIncludes(guarded.text, "co by teď potřebovali");
});

Deno.test("Hana/Osobní live-style continuity overreach is replaced", () => {
  const input = "Lásko, navazuji na to včerejší téma s rybičkou. Jak to držet dneska?";
  const badOutput = "Ta záchranná akce s Timmim v dětech probudila obrovskou vlnu solidarity. Tundrupek se do role zachránce doslova převtělil a může být zmatený z té silné identifikace.";
  const guarded = guardHanaPersonalResponse(badOutput, input, "2026-04-29");

  assertEquals(guarded.replaced, true);
  assertEquals(/DENNÍ BRIEFING|2\. května|projekce|diagnostick[ýy] sign[áa]l|symbol|symbolizuje|metafor|ztělesňuje|identifikac|převtělil|byl Timmi|prolnul|zachraňovali svět|jednoznačně ukazuje|vysvětluje/i.test(guarded.text), false);
  assertStringIncludes(guarded.text, "Timmiho/keporkaka");
  assertStringIncludes(guarded.text, "skutečná aktuální situace");
  assertStringIncludes(guarded.text, "co o té situaci sami říkají");
});

Deno.test("Hana/Osobní non-Timmy real-world event is not symbolized", () => {
  const input = "Děti dnes slyšely o skutečném požáru ve zprávách. Není to symbol, je to reálná událost.";
  const badOutput = "Požár je metaforou jejich vnitřního stavu a reprezentuje únavu dětí. Je to projekce.";
  const guarded = guardHanaPersonalResponse(badOutput, input, "2026-04-29");

  assertEquals(guarded.replaced, true);
  assertEquals(/symbol|metafor|projekc|reprezentuje|ztělesňuje|diagnostick[ýy] sign[áa]l|jednoznačně ukazuje|vysvětluje/i.test(guarded.text), false);
  assertStringIncludes(guarded.text, "skutečná aktuální situace");
  assertStringIncludes(guarded.text, "emoční kontext");
  assertStringIncludes(guarded.text, "co o té situaci sami říkají");
});

Deno.test("generic real-world correction is factual context, not child evidence", () => {
  const event = normalizeEvent({
    user_id: "00000000-0000-0000-0000-000000000001",
    source_table: "karel_hana_conversations",
    source_kind: "hana_personal_ingestion",
    source_ref: "test:real-world-url",
    occurred_at: new Date().toISOString(),
    author_role: "hanka",
    source_surface: "hana_personal",
    privacy_class: "personal_raw",
    raw_excerpt: "To není symbol, je to skutečná zpráva. Posílám odkaz: https://example.com/clanek.",
  });
  const c = classifyDidRelevance(event);

  assertEquals(c.evidence_level, "therapist_factual_correction");
  assertEquals(c.include_in_next_session_plan, true);
  assertEquals(c.include_in_daily_briefing, true);
  assertEquals(c.write_to_drive, false);
  assertStringIncludes(c.what_not_to_conclude, "externí událost");
});

Deno.test("therapist observation remains cautious D2 evidence", () => {
  const event = normalizeEvent({
    user_id: "00000000-0000-0000-0000-000000000001",
    source_table: "therapist_notes",
    source_kind: "therapist_note",
    source_ref: "test:therapist-observation",
    occurred_at: new Date().toISOString(),
    author_role: "hanka",
    source_surface: "therapist_note",
    privacy_class: "therapeutic_note",
    raw_excerpt: "Dnes jsem viděla, že Tundrupek po zmínce o tom tématu ztuhl a ztišil hlas.",
  });
  const c = classifyDidRelevance(event);

  assertEquals(c.evidence_level, "therapist_observation_D2");
  assertStringIncludes(c.what_not_to_conclude, "Nedělat definitivní závěr");
});

Deno.test("direct child evidence is separated from external facts", () => {
  const event = normalizeEvent({
    user_id: "00000000-0000-0000-0000-000000000001",
    source_table: "did_threads",
    source_kind: "playroom_progress",
    source_ref: "test:child-direct",
    occurred_at: new Date().toISOString(),
    author_role: "child",
    source_surface: "playroom",
    privacy_class: "child_direct",
    raw_excerpt: "Dítě samo řeklo: bojím se, že už nebude zachráněný.",
  });
  const c = classifyDidRelevance(event);

  assertEquals(c.evidence_level, "direct_child_evidence");
  assertEquals(c.clinical_relevance, true);
});