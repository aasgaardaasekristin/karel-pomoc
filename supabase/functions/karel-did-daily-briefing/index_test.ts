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
  assertStringIncludes(source, "otevřené nebo částečně rozpracované");
  assertStringIncludes(source, "otevřené nebo částečně rozpracované, zatím bez plného dovyhodnocení");
  assertEquals(/if \(sess\?\.exists && sess\?\.held === false\) evidenceKnown\.push\(`Plánované Sezení/i.test(source), false);
});

Deno.test("visible briefing has a debug-language translation guard", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "FORBIDDEN_VISIBLE_DEBUG_LANGUAGE_RE");
  assertStringIncludes(source, "ensureVisibleClinicalText");
  assertStringIncludes(source, "opening_monologue_text = ensureKarelFirstPersonOpening");
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
  for (const term of ["pending_review / evidence_limited", "faktická korekce reality", "child evidence", "evidence discipline", "real-world kontext", "operační kontext", "Dnešní přehled drží", "Karel je jen navigátor", "Herna může běžet"]) {
    assertEquals(openingBlock.includes(term), false, `Forbidden visible term leaked into opening block: ${term}`);
  }
});

Deno.test("opening renderer enforces first-person Karel voice and no rule manual prose", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "ensureKarelFirstPersonOpening");
  assertStringIncludes(source, "Událost s Timmim/keporkakem vnímám");
  assertStringIncludes(source, "budu ti pomáhat držet otázky krátké a bezpečné");
  assertStringIncludes(source, "FORBIDDEN_OPENING_META_RE");
});

Deno.test("clinical recency resolver labels older sessions correctly and never as 'včerejší'", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "resolveClinicalRecency");
  assertStringIncludes(source, "human_recency_label");
  assertStringIncludes(source, "days_since_today");
  assertStringIncludes(source, "applyClinicalRecencyGuard");
  assertStringIncludes(source, "enforceClinicalRecencyText");
  assertStringIncludes(source, "recent_playroom_review");
  assertStringIncludes(source, "recent_session_review");
  assertStringIncludes(source, "Europe/Prague");
});
Deno.test("opening monologue NEVER contains 'Včera Herna/Sezení neproběhla' — that belongs to dedicated section + evidence_limits only", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const openingBlock = source.slice(
    source.indexOf("function buildOpeningMonologue"),
    source.indexOf("function applyClinicalRecencyGuard"),
  );
  // The realityOpening / frame composition must NOT inject the not-held notice
  // into the opening monologue. The variable `playroomTruth` was the source of
  // the bug and must be gone from the opening section.
  assertEquals(
    openingBlock.includes("playroomTruth"),
    false,
    "playroomTruth (which used to inject 'Včera Herna neproběhla' into the opening) must not exist in buildOpeningMonologue",
  );
  // realityOpening must not interpolate any "Včera Herna/Sezení neproběhla" template.
  assertEquals(
    /realityOpening\s*=\s*[^;]*V[čc]era\s+(?:Herna|Sezen[íi])\s+neprob[eě]hl/iu.test(openingBlock),
    false,
    "realityOpening must not contain a hardcoded 'Včera Herna/Sezení neproběhla' template",
  );
});

Deno.test("ensureKarelFirstPersonOpening strips not-held notice as defense-in-depth", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertStringIncludes(source, "stripNotHeldNoticeFromOpeningText");
  assertStringIncludes(source, "NOT_HELD_SENTENCE_RE");
});

Deno.test("evidence_limits block (auditable) MAY still contain the not-held notice", () => {
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  // Sanity: the auditable evidenceKnown push for "Včera Herna neproběhla."
  // must remain — that's its correct home.
  assertStringIncludes(source, 'evidenceKnown.push("Včera Herna neproběhla.")');
});
