import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("processed operational context remains briefing-relevant without Timmi hardcode", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "OPERATIONAL_EVIDENCE_LEVELS");
  assertStringIncludes(source, "therapist_factual_correction");
  assertStringIncludes(source, "external_fact");
  assertStringIncludes(source, "new Date(Date.now() - 72 * 60 * 60 * 1000)");
});

Deno.test("opening treats pending safety-net session as opened partial, not not-held", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "isOpenedPartialSessionReview");
  assertStringIncludes(source, "otevřené / částečně rozpracované");
  assertStringIncludes(source, "otevřené nebo částečně rozpracované, zatím bez plného dovyhodnocení");
  assertEquals(/if \(sess\?\.exists && sess\?\.held === false\) evidenceKnown\.push\(`Plánované Sezení/i.test(source), false);
});

Deno.test("visible briefing has a debug-language translation guard", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "FORBIDDEN_VISIBLE_DEBUG_LANGUAGE_RE");
  assertStringIncludes(source, "ensureVisibleClinicalText");
  assertStringIncludes(source, "opening_monologue_text = ensureVisibleClinicalText");
  assertStringIncludes(source, "payload.proposed_session[key] = ensureVisibleClinicalText");
  assertStringIncludes(source, "payload.proposed_playroom[key] = ensureVisibleClinicalText");
});

Deno.test("clinical translation layer maps internal states to human prose", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "pending_review\\s*\\/\\s*evidence_limited");
  assertStringIncludes(source, "otevřené nebo částečně rozpracované, zatím bez plného dovyhodnocení");
  assertStringIncludes(source, "Hanička upřesnila faktický rámec");
  assertStringIncludes(source, "skutečná událost");
  assertStringIncludes(source, "vlastní slova, tělesná reakce nebo chování kluků");
});

Deno.test("known debug phrases are not hardcoded into opening visible prose", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const openingBlock = source.slice(source.indexOf("function buildOpeningMonologue"), source.indexOf("function applyOpeningMonologue"));
  for (const term of ["pending_review / evidence_limited", "faktická korekce reality", "child evidence", "evidence discipline", "real-world kontext", "operační kontext"]) {
    assertEquals(openingBlock.includes(term), false, `Forbidden visible term leaked into opening block: ${term}`);
  }
});