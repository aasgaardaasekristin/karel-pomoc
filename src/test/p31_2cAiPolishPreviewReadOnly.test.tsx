/**
 * P31.2C — AI polish read-only preview tests.
 *
 * Verifies:
 *  - preview panel renders when latest canary row exists
 *  - collapsed by default (details element)
 *  - accepted candidate side-by-side
 *  - rejected polished_text NOT in main visible body, only in collapsed audit
 *  - status badges, "no canary" message, "no accepted candidate" message
 *  - main briefing text still uses deterministic karel_text
 *  - no .insert/.update/.delete/.upsert/.rpc/.functions.invoke in component source
 *  - no publish/accept/replace/save button text in component source
 *  - candidates with unsupported/robotic flagged → hidden from primary
 *  - provider_error → audit only
 *  - unknown status → not shown as usable
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let CANARY_ROW: any = null;

vi.mock("@/integrations/supabase/client", () => {
  const makeQuery = () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: CANARY_ROW, error: null }),
    };
    return chain;
  };
  return {
    supabase: { from: () => makeQuery() },
  };
});

import AiPolishCanaryPreviewPanel from "@/components/did/AiPolishCanaryPreviewPanel";

const acceptedSection = {
  section_id: "system_morning_state",
  polish_status: "accepted_candidate",
  warnings: [],
  unsupported_claims_count: 0,
  robotic_phrase_count: 0,
  original_text: "Det orig text A.",
  polished_text: "Polished candidate A.",
};
const rejectedDriftSection = {
  section_id: "today_parts",
  polish_status: "rejected_meaning_drift",
  warnings: ["meaning_drift"],
  unsupported_claims_count: 0,
  robotic_phrase_count: 0,
  original_text: "Det orig text B.",
  polished_text: "POLISHED REJECTED B should hide.",
};
const roboticSection = {
  section_id: "next_step",
  polish_status: "accepted_candidate",
  warnings: [],
  unsupported_claims_count: 0,
  robotic_phrase_count: 2,
  original_text: "Det orig C.",
  polished_text: "ROBOTIC C should hide.",
};
const unsupportedSection = {
  section_id: "unknowns",
  polish_status: "accepted_candidate",
  warnings: [],
  unsupported_claims_count: 1,
  robotic_phrase_count: 0,
  original_text: "Det orig D.",
  polished_text: "UNSUPPORTED D should hide.",
};

const buildRow = (over: Partial<any> = {}) => ({
  id: "c1",
  briefing_id: "b1",
  status: "partial_candidates",
  attempted: true,
  accepted_candidate_count: 1,
  rejected_candidate_count: 1,
  unsupported_claims_count: 0,
  robotic_phrase_count: 0,
  meaning_drift_count: 1,
  model: "google/gemini-2.5-flash",
  sections: [acceptedSection, rejectedDriftSection],
  errors: [],
  created_at: "2026-05-07T05:30:00Z",
  ...over,
});

describe("P31.2C — AI polish read-only preview", () => {
  beforeEach(() => cleanup());

  it("1. renders when latest canary row exists", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await waitFor(() => expect(screen.getByTestId("ai-polish-canary-preview")).toBeInTheDocument());
  });

  it("2. is collapsed by default (details element, no open attr)", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    const el = await screen.findByTestId("ai-polish-canary-preview");
    expect(el.tagName.toLowerCase()).toBe("details");
    expect(el.hasAttribute("open")).toBe(false);
  });

  it("3. accepted candidate shows side-by-side original/polished", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    const sidebyside = await screen.findByTestId("ai-polish-canary-accepted-side-system_morning_state");
    expect(within(sidebyside).getByText("Polished candidate A.")).toBeInTheDocument();
  });

  it("4. rejected_meaning_drift section does NOT expose polished_text in normal body", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    const collapsed = await screen.findByTestId("ai-polish-canary-rejected-collapsed-today_parts");
    // The rejected polished text must live INSIDE a <details> element.
    expect(collapsed.tagName.toLowerCase()).toBe("details");
    expect(collapsed.hasAttribute("open")).toBe(false);
    expect(within(collapsed).getByText(/POLISHED REJECTED B should hide/)).toBeInTheDocument();
  });

  it("5. rejected polished_text appears only inside collapsed audit details", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    const all = screen.getAllByText(/POLISHED REJECTED B should hide/);
    expect(all).toHaveLength(1);
    // Ancestor must be a closed details
    let p: HTMLElement | null = all[0] as HTMLElement;
    let foundClosedDetails = false;
    while (p) {
      if (p.tagName?.toLowerCase() === "details" && !p.hasAttribute("open")) {
        foundClosedDetails = true;
        break;
      }
      p = p.parentElement;
    }
    expect(foundClosedDetails).toBe(true);
  });

  it("6. status badges render", async () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    expect(screen.getByText(/status: partial_candidates/)).toBeInTheDocument();
    expect(screen.getByText(/accepted: 1/)).toBeInTheDocument();
    expect(screen.getByText(/rejected: 1/)).toBeInTheDocument();
  });

  it("7. no canary row → empty message", async () => {
    CANARY_ROW = null;
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await waitFor(() => expect(screen.getByTestId("ai-polish-canary-empty")).toBeInTheDocument());
  });

  it("8. main briefing renderer code uses deterministic karel_text", () => {
    const src = readFileSync(join(process.cwd(), "src/components/did/DidDailyBriefingPanel.tsx"), "utf8");
    expect(src).toContain("s.karel_text");
    // The preview panel is integrated, but main human briefing must NOT read polished_text
    const humanBlock = src.split("data-testid=\"karel-human-briefing\"")[1] || "";
    const upTo = humanBlock.split("</div>")[0];
    expect(upTo).not.toContain("polished_text");
  });

  it("9. main human briefing container does not use polished_text", () => {
    const src = readFileSync(join(process.cwd(), "src/components/did/DidDailyBriefingPanel.tsx"), "utf8");
    expect(src).not.toMatch(/polished_text/);
  });

  it("10. preview component contains no mutation methods", () => {
    const src = readFileSync(join(process.cwd(), "src/components/did/AiPolishCanaryPreviewPanel.tsx"), "utf8");
    for (const banned of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", "functions.invoke"]) {
      expect(src.includes(banned), `must not contain ${banned}`).toBe(false);
    }
  });

  it("11. preview component has no publish/accept/replace/save button text", () => {
    const src = readFileSync(join(process.cwd(), "src/components/did/AiPolishCanaryPreviewPanel.tsx"), "utf8");
    const lower = src.toLowerCase();
    // We allow the validator term "candidate accepted by validator" but no accept/publish ACTION button labels
    expect(lower).not.toMatch(/<button[^>]*>\s*(publish|accept|replace|save polished)/);
    // No invoke patterns
    expect(lower).not.toContain("publish polished");
    expect(lower).not.toContain("save polished");
  });

  it("12. unsupported_claims_count > 0 → candidate hidden from primary", async () => {
    CANARY_ROW = buildRow({ sections: [unsupportedSection], accepted_candidate_count: 0 });
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    const collapsed = await screen.findByTestId("ai-polish-canary-rejected-collapsed-unknowns");
    expect(collapsed.tagName.toLowerCase()).toBe("details");
    expect(collapsed.hasAttribute("open")).toBe(false);
  });

  it("13. robotic_phrase_count > 0 → candidate hidden from primary", async () => {
    CANARY_ROW = buildRow({ sections: [roboticSection], accepted_candidate_count: 0 });
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    const collapsed = await screen.findByTestId("ai-polish-canary-rejected-collapsed-next_step");
    expect(collapsed.tagName.toLowerCase()).toBe("details");
  });

  it("14. provider_error status shows audit warning, not polished as usable", async () => {
    CANARY_ROW = buildRow({ status: "provider_error", accepted_candidate_count: 0, sections: [] });
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    expect(screen.getByTestId("ai-polish-canary-provider-error")).toBeInTheDocument();
  });

  it("15. accepted_candidate_count = 0 → no accepted candidate message", async () => {
    CANARY_ROW = buildRow({ accepted_candidate_count: 0, sections: [rejectedDriftSection] });
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    expect(screen.getByTestId("ai-polish-canary-no-accepted")).toBeInTheDocument();
  });

  it("16. unknown canary status → not shown as usable", async () => {
    CANARY_ROW = buildRow({ status: "weird_new_status", sections: [acceptedSection] });
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={true} />);
    await screen.findByTestId("ai-polish-canary-preview");
    expect(screen.getByTestId("ai-polish-canary-unknown-status")).toBeInTheDocument();
  });

  it("17. humanOk=false → preview not rendered", () => {
    CANARY_ROW = buildRow();
    render(<AiPolishCanaryPreviewPanel briefingId="b1" humanOk={false} />);
    expect(screen.queryByTestId("ai-polish-canary-preview")).toBeNull();
  });
});
