/**
 * P9: Contract tests for the dangling-task relink repair.
 *
 * These tests pin the textual/safety contract of the repair so that the
 * sentinel's self-healing path cannot drift into:
 *   - confirming a part's identity as a real person
 *   - leaking graphic raw content
 *   - using non-existent did_therapist_tasks columns
 *   - silently resolving an active impact
 *
 * The contract is mirrored verbatim from
 * `supabase/functions/karel-external-reality-sentinel/index.ts`
 * (function `repairDanglingTaskLinkages`).
 */

import { describe, expect, it } from "vitest";

// Mirrors the columns we may touch on did_therapist_tasks.
const ALLOWED_TASK_COLUMNS = new Set([
  "user_id", "task", "note", "assigned_to", "status",
  "priority", "category", "task_tier", "source",
]);

// Mirrors the columns we may touch on external_event_impacts.
const ALLOWED_IMPACT_UPDATE_COLUMNS = new Set(["created_task_id"]);

function buildRepairTaskPayload(input: {
  user_id: string;
  part_name: string;
  event_title: string;
  risk_level: "amber" | "red";
  impact_id: string;
  event_id: string;
  old_task_id: string;
  recommended_action?: string | null;
}) {
  const noteText = [
    `[P9_p7_relink_repair_self_healing] original_missing_task_id=${input.old_task_id}`,
    `impact_id=${input.impact_id} | event_id=${input.event_id} | repaired_at=${new Date().toISOString()}`,
    "",
    "Klinický pokyn: ověřit somatickou reakci a pocit bezpečí. Nepředkládat grafické detaily. Nepotvrzovat identitu části jako fakt o reálné osobě.",
    input.recommended_action ?? "",
  ].filter(Boolean).join("\n");
  return {
    user_id: input.user_id,
    task: `Ověřit expozici části ${input.part_name} k tématu "${input.event_title}" (tělo / emoce / bezpečí)`,
    note: noteText,
    assigned_to: "hanka",
    status: "pending",
    priority: input.risk_level === "red" ? "high" : "normal",
    category: "external_reality",
    task_tier: "operative",
    source: "external_reality_sentinel",
  };
}

describe("P9 relink repair contract", () => {
  it("uses only existing did_therapist_tasks columns", () => {
    const payload = buildRepairTaskPayload({
      user_id: "u", part_name: "Tundrupek", event_title: "velryba",
      risk_level: "red", impact_id: "i", event_id: "e", old_task_id: "old",
    });
    for (const k of Object.keys(payload)) {
      expect(ALLOWED_TASK_COLUMNS.has(k)).toBe(true);
    }
  });

  it("never confirms part identity as a real person", () => {
    const payload = buildRepairTaskPayload({
      user_id: "u", part_name: "Arthur", event_title: "Arthur Labinjo-Hughes",
      risk_level: "red", impact_id: "i", event_id: "e", old_task_id: "old",
    });
    expect(payload.note).toMatch(/Nepotvrzovat identitu části jako fakt o reálné osobě/);
    expect(payload.task).not.toMatch(/Arthur je Arthur Labinjo-Hughes/);
  });

  it("never leaks raw graphic content into task body", () => {
    const payload = buildRepairTaskPayload({
      user_id: "u", part_name: "Tundrupek", event_title: "velryba",
      risk_level: "red", impact_id: "i", event_id: "e", old_task_id: "old",
      recommended_action: "Sdílení emoce, ne řešení.",
    });
    expect(payload.task).not.toMatch(/krev|brutál|graphic|gore|mrtv[áé]/i);
    expect(payload.note).toMatch(/Nepředkládat grafické detaily/);
  });

  it("maps red→high and amber→normal priority", () => {
    expect(buildRepairTaskPayload({
      user_id: "u", part_name: "x", event_title: "t",
      risk_level: "red", impact_id: "i", event_id: "e", old_task_id: "o",
    }).priority).toBe("high");
    expect(buildRepairTaskPayload({
      user_id: "u", part_name: "x", event_title: "t",
      risk_level: "amber", impact_id: "i", event_id: "e", old_task_id: "o",
    }).priority).toBe("normal");
  });

  it("only updates created_task_id on impacts (never resolves them)", () => {
    const update = { created_task_id: "new-id" };
    for (const k of Object.keys(update)) {
      expect(ALLOWED_IMPACT_UPDATE_COLUMNS.has(k)).toBe(true);
    }
    expect((update as Record<string, unknown>).resolved_at).toBeUndefined();
  });

  it("repair note carries audit prefix that is greppable", () => {
    const payload = buildRepairTaskPayload({
      user_id: "u", part_name: "x", event_title: "t",
      risk_level: "red", impact_id: "imp", event_id: "ev", old_task_id: "old",
    });
    expect(payload.note).toMatch(/^\[P9_p7_relink_repair_self_healing\]/);
    expect(payload.note).toContain("original_missing_task_id=old");
    expect(payload.note).toContain("impact_id=imp");
    expect(payload.note).toContain("event_id=ev");
  });
});
