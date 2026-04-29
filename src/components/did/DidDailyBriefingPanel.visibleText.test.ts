import { describe, expect, it } from "vitest";
import { backendContextSummary, cleanVisibleClinicalText, realityContextText, toProposedPlayroomView, toProposedSessionView } from "./DidDailyBriefingPanel";

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
  "needs_therapist_input",
  "awaiting_therapist_review",
  "backend_context_inputs",
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
      greeting: "",
      last_3_days: "",
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

  it("does not render a one-block technical fallback as executable session", () => {
    const view = toProposedSessionView({
      part_name: "tundrupek",
      why_today: "pending_review backend_context_inputs",
      led_by: "Hanička",
      first_draft: "Evidence-limited bezpečné ověření připravenosti needs_therapist_input",
      agenda_outline: [{ block: "Evidence-limited bezpečné ověření připravenosti", minutes: 10, detail: "needs_therapist_input" }],
    });

    expect(view?.executable).toBe(false);
    expect(view?.blocks).toHaveLength(0);
    expect(view?.status_label).toContain("není připraveno");
    expectClean(JSON.stringify(view));
  });

  it("keeps therapist-led session role contract visible and safe", () => {
    const view = toProposedSessionView({
      part_name: "tundrupek",
      why_today: "Ověřit aktuální stav.",
      led_by: "Hanička",
      duration_min: 45,
      first_draft: "Terapeutkou vedené sezení.",
      agenda_outline: [
        { block: "Bezpečný vstup", minutes: 8, detail: "Ověřit bezpečí." },
        { block: "Mapování těla", minutes: 10, detail: "Sledovat tělesnou reakci." },
        { block: "Opatrné téma", minutes: 15, detail: "Nabídnout volbu." },
        { block: "Měkké ukončení", minutes: 8, detail: "Shrnout ověřené." },
      ],
    });

    expect(view?.executable).toBe(true);
    expect(view?.lead).toBe("Hanička");
    expect(view?.status_label).toContain("Karel asistuje");
    expect(view?.blocks.length).toBeGreaterThanOrEqual(4);
  });

  it("renders playroom as human text with therapist approval gate", () => {
    const view = toProposedPlayroomView({
      part_name: "tundrupek",
      status: "awaiting_therapist_review",
      why_this_part_today: "backend_context_inputs source_ref",
      main_theme: "Bezpečný kontakt",
      goals: ["needs_therapist_input", "ověřit dostupnost"],
      playroom_plan: {
        therapeutic_program: [{ block: "Bezpečný práh", minutes: 3, detail: "awaiting_therapist_review" }],
        child_safe_version: "Dnes jen opatrně.",
        risks_and_stop_signals: ["zahlcení"],
      },
    });

    expect(view?.lead_label).toBe("vede Karel");
    expect(view?.approval_label).toContain("schválení terapeutkami");
    expectClean(JSON.stringify(view));
  });
});
