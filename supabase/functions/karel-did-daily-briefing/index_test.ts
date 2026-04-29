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
  assertStringIncludes(source, "pending_review / evidence_limited");
  assertEquals(/if \(sess\?\.exists && sess\?\.held === false\) evidenceKnown\.push\(`Plánované Sezení/i.test(source), false);
});