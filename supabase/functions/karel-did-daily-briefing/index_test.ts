import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildBriefingOpeningForTest, operationalContextEntriesForTest } from "./index.ts";

Deno.test("processed operational context remains briefing-relevant without Timmi hardcode", () => {
  const entries = operationalContextEntriesForTest({
    pantry_b_entries: [{
      id: "p1",
      source_kind: "hana_personal_ingestion",
      source_ref: "hana:test:generic-fire",
      summary: "faktická korekce reality má přednost před původním plánem; držet evidence discipline.",
      processed_at: new Date().toISOString(),
      detail: {
        evidence_level: "therapist_factual_correction",
        include_in_next_session_plan: true,
        include_in_next_playroom_plan: true,
        what_not_to_conclude: "Do not treat external fact as child projection without direct child response.",
      },
    }],
  });

  assertEquals(entries.length, 1);
  assertEquals(entries[0].source_ref, "hana:test:generic-fire");
});

Deno.test("opening treats pending safety-net session as opened partial, not not-held", () => {
  const opening = buildBriefingOpeningForTest({
    yesterday_session_review: {
      exists: true,
      held: false,
      status: "pending_review",
      review_status: "pending_review",
      review_kind: "safety_net_opened_partial",
      fallback_reason: "opened_or_partial_activity_detected",
      part_name: "Tundrupek",
      practical_report_text: "Včerejší Sezení bylo otevřené nebo částečně rozpracované, ale zatím nemá plné dovyhodnocení.",
      evidence_items: [{ kind: "session_started_evidence", available: true }],
      analysis_json: { outcome: "started_partial" },
    },
    proposed_session: { part_name: "Tundrupek", why_today: "navázat opatrně" },
  }, { pantry_b_entries: [] }, [{ part_name: "Tundrupek", score: 1, reasons: [] }]);

  assertStringIncludes(opening.opening_monologue_text, "otevřené nebo částečně rozpracované");
  assertStringIncludes(opening.opening_monologue_text, "pending_review / evidence_limited");
  assertEquals(/Sezení neproběhlo|klinicky neproběhlo|nedošlo k sezení/i.test(opening.opening_monologue_text), false);
});