import { describe, it, expect } from "vitest";
import { buildDedupeKey } from "@/lib/dynamicPipeline";

describe("P28_CDI_2 dedupe key", () => {
  it("is deterministic", () => {
    const a = buildDedupeKey(["hana_msg", "thread-1", 5]);
    const b = buildDedupeKey(["hana_msg", "thread-1", 5]);
    expect(a).toBe(b);
  });
  it("differs by surface", () => {
    const a = buildDedupeKey(["hana_msg", "thread-1", 5]);
    const b = buildDedupeKey(["task_answer", "thread-1", 5]);
    expect(a).not.toBe(b);
  });
});
