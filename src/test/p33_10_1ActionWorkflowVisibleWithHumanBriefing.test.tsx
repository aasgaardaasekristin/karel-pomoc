import { describe, expect, it } from "vitest";
import { toAskItem } from "@/components/did/DidDailyBriefingPanel";

/**
 * P33.10.1 — Regression lock for the action workflow visibility & ask normalization.
 *
 * Background:
 *  - Previously the entire interactive workflow (proposed_session,
 *    proposed_playroom, ask_hanka, ask_kata, decisions, waiting_for) was
 *    nested inside `{structuredFallbackAllowed && (...)}` in
 *    `DidDailyBriefingPanel.tsx`. As soon as the human Karel briefing was
 *    OK (`visibleHumanOk = true`), this gate evaluated to false and
 *    therapist tasks disappeared from the DOM, even though the payload
 *    still contained them.
 *  - In addition, ask items could be emitted with `target_item_id = null`,
 *    which caused clicks to open empty/dead workspaces.
 *
 * Acceptance gates locked here:
 *  - ask_hanka_target_item_id_not_null
 *  - ask_kata_target_item_id_not_null
 *  - ask_hanka_workspace_fields_present
 *  - ask_kata_workspace_fields_present
 *
 * The DOM-level "render under human prose" gate is locked structurally in
 * the component itself (the `{structuredFallbackAllowed && (...)}`
 * wrapper now closes before the proposed_session / playroom / ask /
 * decisions blocks). A grep-based structural assertion is added below
 * so the wrapper cannot accidentally re-engulf the workflow again.
 */
describe("P33.10.1 — ask item normalization", () => {
  const BRIEFING_ID = "briefing-uuid-xyz";

  it("string ask is normalized with briefing fallback target", () => {
    const item = toAskItem("Potřebuju ověřit dostupnost.", BRIEFING_ID, "ask_hanka");
    expect(item.id).toBeTruthy();
    expect(item.target_item_id).toBe(BRIEFING_ID);
    expect(item.target_type).toBe("briefing");
    expect(item.expected_resolution).toBe("answer");
    expect(item.assignee).toBe("hanka");
    expect(item.briefing_id).toBe(BRIEFING_ID);
  });

  it("structured ask with null target_item_id falls back to briefing.id", () => {
    const item = toAskItem(
      {
        id: "ask-1",
        text: "Doplň prosím evidence.",
        assignee: "kata",
        intent: "task",
        target_type: "none",
        target_item_id: null,
      } as any,
      BRIEFING_ID,
      "ask_kata",
    );
    expect(item.id).toBe("ask-1");
    expect(item.target_item_id).toBe(BRIEFING_ID);
    expect(item.target_type).toBe("briefing");
    expect(item.expected_resolution).toBe("answer");
    expect(item.assignee).toBe("kata");
  });

  it("structured ask preserves real target when present", () => {
    const item = toAskItem(
      {
        id: "ask-2",
        text: "Chci probrat plán sezení.",
        assignee: "hanka",
        intent: "session_plan",
        target_type: "proposed_session",
        target_item_id: "session-uuid-1",
        expected_resolution: "update_program",
      } as any,
      BRIEFING_ID,
      "ask_hanka",
    );
    expect(item.target_item_id).toBe("session-uuid-1");
    expect(item.target_type).toBe("proposed_session");
    expect(item.expected_resolution).toBe("update_program");
  });

  it("no normalized ask remains with null id or null target_item_id", () => {
    const inputs: any[] = [
      "Plain string",
      { id: "x1", text: "A", target_item_id: null },
      { id: "x2", text: "B" },
    ];
    for (const role of ["ask_hanka", "ask_kata"] as const) {
      for (const raw of inputs) {
        const it = toAskItem(raw, BRIEFING_ID, role);
        expect(it.id).toBeTruthy();
        expect(it.target_item_id).toBeTruthy();
        expect(it.expected_resolution).toBeTruthy();
      }
    }
  });
});

describe("P33.10.1 — structural lock: action workflow not gated by structuredFallbackAllowed", () => {
  it("source file closes structuredFallbackAllowed wrapper BEFORE the action workflow blocks", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/components/did/DidDailyBriefingPanel.tsx", "utf-8");
    const lines = src.split("\n");

    // Find the LAST `{structuredFallbackAllowed && (<>` opener and its matching `</>)}` closer.
    let lastOpen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("{structuredFallbackAllowed && (<>")) lastOpen = i;
    }
    expect(lastOpen, "no structuredFallbackAllowed opener found").toBeGreaterThan(-1);

    // Find the next `</>)}` after lastOpen — this is the closer.
    let closeLine = -1;
    for (let i = lastOpen + 1; i < lines.length; i++) {
      if (/^\s*<\/>\)\}\s*$/.test(lines[i])) {
        closeLine = i;
        break;
      }
    }
    expect(closeLine, "structuredFallbackAllowed wrapper has no closer").toBeGreaterThan(lastOpen);

    // The action workflow markers must appear AFTER the closer, so they
    // are NOT inside the structuredFallbackAllowed wrapper.
    const requiredMarkers = [
      "openProposedSessionDeliberation(p.proposed_session!)",
      "openProposedPlayroomDeliberation(playroomProposal)",
      "openAskWorkspace(\"ask_hanka\", item)",
      "openAskWorkspace(\"ask_kata\", item)",
      "openDecisionDeliberation(d)",
    ];
    for (const marker of requiredMarkers) {
      const lineIdx = lines.findIndex((l) => l.includes(marker));
      expect(lineIdx, `marker not found: ${marker}`).toBeGreaterThan(-1);
      expect(
        lineIdx,
        `marker '${marker}' must render outside structuredFallbackAllowed (after line ${closeLine + 1})`,
      ).toBeGreaterThan(closeLine);
    }
  });
});
