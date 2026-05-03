/**
 * P6 false-green static audit:
 *   the operational coverage check must NOT contain the forbidden pattern
 *   `count >= 0 ? "ok"` and similar lazy-green forms.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COVERAGE_FILE = resolve(
  process.cwd(),
  "supabase/functions/karel-operational-coverage-check/index.ts",
);

describe("P6 false-green audit (static)", () => {
  const src = readFileSync(COVERAGE_FILE, "utf-8");

  it("does not use `count >= 0 ? \"ok\"` pattern (false green)", () => {
    // Strip line comments so commentary like "// count >= 0 ? ..." doesn't trip the audit.
    const noLineComments = src.replace(/^\s*\/\/.*$/gm, "");
    const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
    const forbidden = />=\s*0\s*\?\s*["']ok["']/i;
    expect(forbidden.test(noBlockComments)).toBe(false);
  });

  it("uses evidenceStatus() helper for evidence-based pipelines", () => {
    expect(src.includes("function evidenceStatus(")).toBe(true);
    expect(src.includes("evidenceStatus(")).toBe(true);
  });

  it("never marks a pipeline status: \"ok\" without an evidence_ref or design rationale", () => {
    // crude: any line containing `status: "ok"` (not inside the evidenceStatus helper,
    // and not a TypeScript type-union annotation like `"ok" | "degraded"`)
    // must be paired with an `evidence_ref` within the next 6 lines.
    const lines = src.split("\n");
    const offenders: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        /status:\s*"ok"/.test(line) &&
        !/evidenceStatus/.test(line) &&
        !/"ok"\s*\|/.test(line)
      ) {
        const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
        if (!/evidence_ref/.test(window)) offenders.push(i + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});
