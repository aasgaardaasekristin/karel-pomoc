import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../");
const fnSrc = readFileSync(
  resolve(root, "supabase/functions/update-operative-plan/index.ts"),
  "utf-8",
);

describe("P29B.3-H1.1 update-operative-plan governance fix", () => {
  it("does not reference the legacy 05_PLAN folder anywhere", () => {
    // Allowed: '05A...', 'Operativni_Plan' substring within canonical path. Forbidden: bare '05_PLAN'.
    expect(/['"`]05_PLAN['"`]/.test(fnSrc)).toBe(false);
    expect(fnSrc).not.toMatch(/findFolder\([^)]*05_PLAN/);
    expect(fnSrc).not.toContain('"05_PLAN not found"');
  });

  it("uses the canonical KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN target", () => {
    expect(fnSrc).toContain("KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN");
  });

  it("routes the write through the P29A governance gate (safeEnqueueDriveWrite)", () => {
    expect(fnSrc).toContain("safeEnqueueDriveWrite");
    expect(fnSrc).toMatch(/from\s+["']\.\.\/_shared\/documentGovernance\.ts["']/);
  });

  it("does not import legacy direct-Drive helpers (overwriteDoc / findFolder)", () => {
    expect(fnSrc).not.toMatch(/\boverwriteDoc\b/);
    expect(fnSrc).not.toMatch(/\bfindFolder\b/);
    expect(fnSrc).not.toMatch(/\bcreateBackup\b/);
  });

  it("throws a controlled error if the governance enqueue is rejected", () => {
    expect(fnSrc).toContain("governance_enqueue_failed");
  });
});
