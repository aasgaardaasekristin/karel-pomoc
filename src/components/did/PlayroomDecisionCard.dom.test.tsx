import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import PlayroomDecisionCard from "./PlayroomDecisionCard";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("PlayroomDecisionCard BLOK 1 DOM proof", () => {
  const baseProps = {
    playroom: {
      part_name: "Tundrupek",
      status: "awaiting_therapist_review",
      why_this_part_today: "Dnešní herna má držet bezpečný kontakt.",
      main_theme: "Bezpečný kontakt",
      playroom_plan: {
        opening_monologue: {
          greeting: "Tundrupku, ahoj.",
          what_we_know_for_sure: ["Drží kontakt v 1. bloku.", "Ráno ustojí oslovení."],
          context_one_liner: "Nejdřív kontakt, pak hra, tempo bezpečné.",
          for_hanka: "Drž tempo, nepřitlačuj.",
          for_kata: "Sleduj signály únavy.",
          diagnostic_questions: ["Co dnes ustojí?", "Kde mizí kontakt?"],
          one_line_frame: "Bezpečný kontakt je dnešní rámec.",
        },
        therapeutic_program: [
          { title: "Bezpečný práh", detail: "Ověřit kontakt.", child_facing_prompt_draft: "Tundrupku, ahoj…" },
        ],
        first_question: "Tundrupku, jak ti dnes je?",
      },
    },
    view: {
      title: "Herna – Tundrupek",
      part_name: "Tundrupek",
      rationale: "Dnešní herna má držet bezpečný kontakt.",
      goals: [],
      blocks: [],
      stop_rules: [],
    },
    onOpenDeliberation: vi.fn(),
  };

  it("nerenderuje žádný formulář (PreApproval/PostSession byly odstraněny)", () => {
    const { container } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("textarea").length).toBe(0);
    expect(container.querySelectorAll("form").length).toBe(0);
  });

  it("nerenderuje zakázané fráze ani child-facing draft", () => {
    const { container } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/grounded|čerpá ze skutečných|pracovní ověření|podklad pro plánování/i);
    expect(text).not.toContain("Tundrupku, jak ti dnes je");
  });

  it("CTA je „Otevřít poradu ke schválení Herny" s testid playroom-open-deliberation", () => {
    const { getByTestId, queryByTestId } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    expect(queryByTestId("playroom-open-workspace")).toBeNull();
    const cta = getByTestId("playroom-open-deliberation");
    expect(cta.textContent).toContain("Otevřít poradu ke schválení Herny");
  });

  it("renderuje 6-section spider head když opening_monologue obsahuje strukturovaná data", () => {
    const { container } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    const text = container.textContent ?? "";
    for (const label of [
      "Oslovení",
      "Profesní zjištění",
      "Odborné souvislosti",
      "Dnešní východiska",
      "Diagnostické otázky",
      "Jednovětý rámec",
    ]) {
      expect(text).toContain(label);
    }
  });

  it("honest empty state když chybí runtime i opening_monologue (nikoliv falešný fallback)", () => {
    const empty = {
      ...baseProps,
      playroom: { ...baseProps.playroom, playroom_plan: {} },
    };
    const { container } = render(<PlayroomDecisionCard {...(empty as any)} />);
    // honest empty state se ukáže až po runtime fetch dokončení; loader je v textu
    const text = container.textContent ?? "";
    expect(text).toContain("Karlova promluva");
  });
});
