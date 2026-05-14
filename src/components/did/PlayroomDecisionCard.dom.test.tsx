import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import PlayroomDecisionCard from "./PlayroomDecisionCard";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("PlayroomDecisionCard DOM proof", () => {
  it("nikdy nezobrazí zakázaný prázdný fallback ani samotnou nulu", () => {
    const { container } = render(
      <PlayroomDecisionCard
        playroom={{
          part_name: "Tundrupek",
          status: "awaiting_therapist_review",
          why_this_part_today: "Dnešní herna má držet bezpečný kontakt.",
          main_theme: "Bezpečný kontakt",
          playroom_plan: {
            therapeutic_program: [{ title: "Bezpečný práh", detail: "Ověřit kontakt." }],
          },
        }}
        view={{
          title: "Herna – Tundrupek",
          part_name: "Tundrupek",
          rationale: "Dnešní herna má držet bezpečný kontakt.",
          goals: [],
          blocks: [],
          stop_rules: [],
        }}
        onOpenDeliberation={vi.fn()}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("Karlova promluva pro tuto hernu zatím nebyla vygenerována");
    expect(text).not.toMatch(/(^|\n)\s*0\s*(\n|$)/);
  });
});