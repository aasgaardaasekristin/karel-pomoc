import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enforceClinicalRecencyText, resolveClinicalRecency, revalidateCachedBriefingForViewer } from "./index.ts";

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


Deno.test("3-date recency: Herna from 2026-04-27 is not yesterday for 2026-04-30 viewer", () => {
  const recency = resolveClinicalRecency("2026-04-27", { briefing_date: "2026-04-30", viewer_date: "2026-04-30" }, "playroom");
  assertEquals(recency.days_since_reference, 3);
  assertEquals(recency.human_recency_label, "před 3 dny");
  assertEquals(recency.visible_label, "Poslední Herna");
  assertEquals(recency.is_yesterday, false);
  assert(!/V[čc]erej[šs][íi]/u.test(recency.visible_sentence_prefix));
});

Deno.test("3-date recency: truly yesterday playroom may say Včerejší Herna", () => {
  const recency = resolveClinicalRecency("2026-04-29", { briefing_date: "2026-04-30", viewer_date: "2026-04-30" }, "playroom");
  assertEquals(recency.days_since_reference, 1);
  assertEquals(recency.human_recency_label, "včera");
  assertEquals(recency.is_yesterday, true);
  assertStringIncludes(recency.visible_label, "Včerejší Herna");
  assertStringIncludes(recency.visible_sentence_prefix, "Včerejší Herna");
});

Deno.test("cached briefing after midnight revalidates yesterday labels against viewer_date", () => {
  const cached = {
    id: "cached",
    briefing_date: "2026-04-30",
    payload: {
      opening_monologue_text: "Dobré ráno. Včerejší Herna proběhla 29. 4. 2026. Dnes navazujeme opatrně.",
      recent_playroom_review: {
        exists: true,
        source_date_iso: "2026-04-29",
        session_date_iso: "2026-04-29",
        is_yesterday: true,
        human_recency_label: "včera",
      },
    },
  };
  const out = revalidateCachedBriefingForViewer(cached, "2026-05-01");
  assertEquals(out.payload.viewer_meta.is_current_briefing, false);
  assertEquals(out.payload.viewer_meta.days_since_briefing, 1);
  assertEquals(out.payload.recent_playroom_review.days_since_today, 2);
  assertEquals(out.payload.recent_playroom_review.human_recency_label, "předevčírem");
  assert(!/V[čc]erej[šs][íi]/u.test(out.payload.opening_monologue_text));
});

Deno.test("dated yesterday sentence is rewritten when viewer_date makes it older", () => {
  const payload = {
    recent_session_review: {
      exists: true,
      source_date_iso: "2026-04-29",
      session_date_iso: "2026-04-29",
      days_since_today: 2,
      days_since_briefing_date: 2,
      human_recency_label: "předevčírem",
      is_yesterday: false,
    },
  };
  const out = enforceClinicalRecencyText("Včerejší Sezení proběhlo 29. 4. 2026.", payload);
  assert(!/V[čc]erej[šs][íi]/u.test(out));
  assertStringIncludes(out, "29. 4. 2026");
  assert(/p[řr]edev[čc][íi]rem|Posledn[íi].*Sezen[íi]/u.test(out));
});

Deno.test("days===1 must NOT emit frozen 'Včerejší X proběhlo DD. M. YYYY' pattern", () => {
  // briefing for 2026-04-30, source from 2026-04-29 (literally yesterday)
  const sess = resolveClinicalRecency({
    source_date_iso: "2026-04-29",
    briefing_date_iso: "2026-04-30",
    viewer_date_iso: "2026-04-30",
    kind: "session",
    exists: true,
    held: true,
  });
  assertEquals(sess.days_since_reference, 1);
  assertEquals(sess.human_recency_label, "včera");
  assert(
    !/V[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo\s+\d/.test(sess.visible_sentence_prefix || ""),
    `prefix must not contain frozen "Včerejší Sezení proběhlo …" — got: ${sess.visible_sentence_prefix}`,
  );
  assertStringIncludes(sess.visible_sentence_prefix || "", "29. 4. 2026");
  assertStringIncludes(sess.visible_sentence_prefix || "", "včera");

  const play = resolveClinicalRecency({
    source_date_iso: "2026-04-29",
    briefing_date_iso: "2026-04-30",
    viewer_date_iso: "2026-04-30",
    kind: "playroom",
    exists: true,
    held: true,
  });
  assert(
    !/V[čc]erej[šs][íi]\s+Herna\s+prob[eě]hla\s+\d/.test(play.visible_sentence_prefix || ""),
    `prefix must not contain frozen "Včerejší Herna proběhla …" — got: ${play.visible_sentence_prefix}`,
  );
  assertStringIncludes(play.visible_sentence_prefix || "", "včera");
});

Deno.test("section heading 'VČEREJŠÍ DŮLEŽITÝ KONTEXT' is rewritten to 'DŮLEŽITÝ KONTEXT Z POSLEDNÍCH DNÍ'", () => {
  const out = enforceClinicalRecencyText("VČEREJŠÍ DŮLEŽITÝ KONTEXT", {});
  assertEquals(out.includes("VČEREJŠÍ DŮLEŽITÝ KONTEXT"), false);
  assertStringIncludes(out, "DŮLEŽITÝ KONTEXT Z POSLEDNÍCH DNÍ");
});
