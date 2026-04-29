import { describe, expect, it } from "vitest";
import { backendContextSummary, cleanVisibleClinicalText, realityContextText } from "./DidDailyBriefingPanel";

const forbidden = [
  "pending_review",
  "evidence_limited",
  "child evidence",
  "evidence discipline",
  "therapist_factual_correction",
  "external_fact",
  "real-world context",
  "real-world kontext",
  "operational context",
  "operační kontext",
  "briefing_input",
  "source_ref",
  "source_kind",
  "backend_context_inputs",
  "processed_at",
  "ingestion",
  "Pantry B",
  "karel_pantry_b_entries",
  "did_event_ingestion_log",
  "faktická korekce reality",
];

const expectClean = (text: string) => {
  for (const term of forbidden) {
    expect(text.toLowerCase()).not.toContain(term.toLowerCase());
  }
};

describe("DidDailyBriefingPanel visible clinical text helpers", () => {
  it("translates internal statuses into human clinical prose", () => {
    const text = cleanVisibleClinicalText(
      "pending_review / evidence_limited; therapist_factual_correction / external_fact; child evidence; evidence discipline; source_ref; backend_context_inputs; faktická korekce reality",
    );

    expectClean(text);
    expect(text).toContain("otevřené nebo částečně rozpracované");
    expect(text).toContain("Hanička upřesnila faktický rámec");
    expect(text).toContain("skutečné události");
    expect(text).toContain("vlastní slova, tělesná reakce nebo chování kluků");
  });

  it("renders backend context summary without audit metadata terms", () => {
    const text = backendContextSummary({
      used_recent_operational_context: true,
      source_refs: ["source_ref:abc"],
      backend_context_inputs: true,
      what_not_to_conclude: ["real-world context is not child evidence"],
    });

    expectClean(text);
    expect(text).toContain("Používá včerejší důležitý kontext");
    expect(text).toContain("Nejdřív ověřit vlastní reakci kluků");
  });

  it("renders reality context as user-facing prose", () => {
    const text = realityContextText({
      decisions: [],
      ask_hanka: [],
      ask_kata: [],
      closing: "",
      operational_context_used: [
        {
          summary: "Timmi/keporkak: therapist_factual_correction; faktická korekce reality; not child evidence; source_ref",
          evidence_level: "external_fact",
        },
      ],
    });

    expectClean(text);
    expect(text).toContain("Timmi/keporkak");
    expect(text).toContain("Samo o sobě to ještě nevypovídá");
  });
});
