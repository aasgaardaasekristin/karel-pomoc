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

describe("PlayroomDecisionCard FÁZE 1 DOM proof", () => {
  const baseProps = {
    playroom: {
      part_name: "Tundrupek",
      status: "awaiting_therapist_review",
      why_this_part_today: "Dnešní herna má držet bezpečný kontakt.",
      main_theme: "Bezpečný kontakt",
      playroom_plan: {
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
    onOpenWorkspace: vi.fn(),
  };

  it("nerenderuje zakázaný fallback, samotnou nulu, ani child-facing draft", () => {
    const { container } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Karlova promluva pro tuto hernu zatím nebyla vygenerována");
    expect(text).not.toMatch(/(^|\n)\s*0\s*(\n|$)/);
    expect(text).not.toContain("Tundrupku, ahoj");
    expect(text).not.toContain("Tundrupku, jak ti dnes je");
    expect(text).not.toContain("čeká na vstupy terapeutek");
  });

  it("nerenderuje CTA do porady a má CTA Otevřít dnešní workspace", () => {
    const { container, getByTestId } = render(<PlayroomDecisionCard {...(baseProps as any)} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Otevřít poradu ke schválení Herny");
    expect(getByTestId("playroom-open-workspace").textContent).toContain("Otevřít dnešní workspace");
  });
});
