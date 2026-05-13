// P33.11 STEP 1 — Visible proof that rail reply uses approved child_facing_prompt_draft.
// Hardcoded sluníčko/vločka must remain only as last-resort fallback.
import { describe, it, expect } from "vitest";
import { __test_buildRailReply } from "@/components/did/DidKidsPlayroom";

const makePlan = (childFacing: string | null) => ({
  id: "plan-test",
  urgency_breakdown: {
    playroom_plan: {
      therapeutic_program: [
        {
          step: 1,
          title: "Otevření",
          method: "kontakt",
          detail: "navázání",
          child_facing_prompt_draft: childFacing,
          karel_response_strategy: "naslouchat",
          expected_response_range: [],
          stop_if: [],
          fallback: "blíž / dál / ticho",
        },
      ],
    },
  },
} as any);

describe("P33.11 STEP 1 — rail reply source", () => {
  it("uses approved child_facing_prompt_draft when present", () => {
    const plan = makePlan("Ukaž mi jeden malý kamínek z dnešního dne.");
    const reply = __test_buildRailReply(plan, { currentBlockIndex: 0, completedBlockIndexes: [] }, "Tundrupku", "ahoj");
    expect(reply).toContain("Ukaž mi jeden malý kamínek z dnešního dne.");
    expect(reply).toContain("[PHASE: PROGRAM]");
    expect(reply).toContain("[BLOCK: 1]");
    expect(reply).toContain("[SOURCE: approved child_facing_prompt_draft (rail reply)]");
    // Hardcoded fallback must NOT appear.
    expect(reply).not.toMatch(/sluníčko, B\) vločka/);
  });

  it("falls back to hardcoded reply when approved prompt missing — and labels it explicitly", () => {
    const plan = makePlan(null);
    const reply = __test_buildRailReply(plan, { currentBlockIndex: 0, completedBlockIndexes: [] }, "Tundrupku", "ahoj");
    expect(reply).toContain("[SOURCE: fallback rail reply used]");
    expect(reply).toContain("[PHASE: PROGRAM]");
    expect(reply).toContain("[BLOCK: 1]");
  });
});
