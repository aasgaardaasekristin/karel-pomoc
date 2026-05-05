import { describe, it, expect } from "vitest";
import { buildDedupeKey } from "@/lib/dynamicPipeline";

describe("dynamicPipeline.buildDedupeKey", () => {
  it("returns identical hash for identical parts", () => {
    const a = buildDedupeKey(["delib_answer", "abc", "hanka", 0]);
    const b = buildDedupeKey(["delib_answer", "abc", "hanka", 0]);
    expect(a).toBe(b);
  });

  it("returns different hash when any part changes", () => {
    const a = buildDedupeKey(["delib_answer", "abc", "hanka", 0]);
    const b = buildDedupeKey(["delib_answer", "abc", "hanka", 1]);
    expect(a).not.toBe(b);
  });

  it("treats null and undefined as empty consistently", () => {
    expect(buildDedupeKey(["x", null, "y"])).toBe(buildDedupeKey(["x", undefined, "y"]));
  });
});
