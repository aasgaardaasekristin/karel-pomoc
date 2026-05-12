/**
 * P33.10.2 — Drive Read Containment regression lock.
 *
 * Locks in the source-level guarantees from Parts D / E / F:
 *   - karel-did-drive-read enforces budget, depth, folder/file caps.
 *   - recursive / global search default to false.
 *   - controlled-timeout returns a structured JSON envelope (HTTP 200), not 504.
 *   - safeDriveRead client wrapper aborts within budget and never throws.
 *   - Pracovna / Karlův přehled callers use safeDriveRead, not raw fetch.
 *   - karel-did-part-summary passes recursive:false + allowGlobalSearch:false.
 *   - DidLiveSessionPanel handles drive-read failure as a non-blocking note.
 *   - No raw Drive content / secret values are logged from drive-read.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("P33.10.2 — Drive Read Containment", () => {
  describe("Part D — server containment", () => {
    const fn = readFile("supabase/functions/karel-did-drive-read/index.ts");

    it("declares OVERALL_BUDGET_MS <= 45_000", () => {
      expect(fn).toMatch(/OVERALL_BUDGET_MS\s*=\s*45_000/);
    });
    it("declares per-fetch timeout via AbortController", () => {
      expect(fn).toMatch(/PER_FETCH_TIMEOUT_MS\s*=\s*8_000/);
      expect(fn).toMatch(/new AbortController\(\)/);
    });
    it("enforces depth, folder and file limits", () => {
      expect(fn).toMatch(/MAX_DEPTH_DEFAULT\s*=\s*2/);
      expect(fn).toMatch(/MAX_FOLDERS_DEFAULT\s*=\s*80/);
      expect(fn).toMatch(/MAX_FILES_DEFAULT\s*=\s*300/);
    });
    it("caps global search results", () => {
      expect(fn).toMatch(/MAX_GLOBAL_SEARCH_RESULTS\s*=\s*30/);
    });
    it("defaults recursive=false and allowGlobalSearch=false", () => {
      expect(fn).toMatch(/recursive\s*=\s*false/);
      expect(fn).toMatch(/allowGlobalSearch\s*=\s*false/);
    });
    it("returns controlled_timeout envelope instead of throwing", () => {
      expect(fn).toMatch(/status:\s*"controlled_timeout"/);
      expect(fn).toMatch(/"drive_read_budget_exhausted"/);
      // controlledTimeout helper returns HTTP 200, not 504.
      expect(fn).toMatch(/status:\s*200/);
    });
    it("logs only structured, secret-free metadata", () => {
      expect(fn).toMatch(/tag:\s*"\[drive-read\]"/);
      // Must not log raw Drive content / refresh tokens.
      expect(fn).not.toMatch(/console\.log\([^)]*cardContent/);
      expect(fn).not.toMatch(/GOOGLE_REFRESH_TOKEN.*console/);
    });
  });

  describe("Part E — client fail-soft wrapper", () => {
    const wrap = readFile("src/lib/safeDriveRead.ts");
    it("aborts after a strict client budget", () => {
      expect(wrap).toMatch(/AbortController/);
      expect(wrap).toMatch(/budgetMs\s*\?\?\s*12_000/);
    });
    it("never throws — returns ok:false on failure", () => {
      expect(wrap).toMatch(/return\s*{\s*ok:\s*false/);
    });
    it("emits a single non-blocking toast on failure", () => {
      expect(wrap).toMatch(/lastWarnAt/);
      expect(wrap).toMatch(/Drive detail se teď nepodařilo načíst/);
    });
    it("defaults recursive=false and allowGlobalSearch=false", () => {
      expect(wrap).toMatch(/recursive:\s*opts\.recursive\s*\?\?\s*false/);
      expect(wrap).toMatch(/allowGlobalSearch:\s*opts\.allowGlobalSearch\s*\?\?\s*false/);
    });
  });

  describe("Part C / F — Pracovna callers use safeDriveRead", () => {
    const chat = readFile("src/pages/Chat.tsx");
    it("imports safeDriveRead", () => {
      expect(chat).toMatch(/from\s+"@\/lib\/safeDriveRead"/);
    });
    it("DID-mode open does not raw-fetch karel-did-drive-read", () => {
      // The branch entered when prevModeRef.current !== mode and mode === "childcare"
      // pre-loads basic centrum docs. It must use safeDriveRead.
      const idx = chat.indexOf("Drive enrichment is non-blocking");
      expect(idx).toBeGreaterThan(-1);
      const slice = chat.slice(idx, idx + 2000);
      expect(slice).not.toMatch(/fetch\([^)]*karel-did-drive-read/);
      expect(slice).toMatch(/safeDriveRead\(/);
      expect(slice).toMatch(/caller:\s*"Chat\.tsx:childcare-open"/);
    });
    it("loadDriveContext helper uses safeDriveRead", () => {
      const idx = chat.indexOf("const loadDriveContext");
      expect(idx).toBeGreaterThan(-1);
      const slice = chat.slice(idx, idx + 1200);
      expect(slice).toMatch(/safeDriveRead\(/);
      expect(slice).not.toMatch(/fetch\([^)]*karel-did-drive-read/);
    });
    it("no remaining raw fetch to karel-did-drive-read in Chat.tsx", () => {
      const matches = chat.match(/fetch\(\s*`[^`]*karel-did-drive-read/g) || [];
      expect(matches.length).toBe(0);
    });
  });

  describe("Server callers: bounded payload", () => {
    it("karel-did-part-summary opts out of global recursion", () => {
      const f = readFile("supabase/functions/karel-did-part-summary/index.ts");
      expect(f).toMatch(/allowGlobalSearch:\s*false/);
      expect(f).toMatch(/recursive:\s*false/);
    });
  });

  describe("DidLiveSessionPanel — drive_read action is non-blocking", () => {
    const f = readFile("src/components/did/DidLiveSessionPanel.tsx");
    it("handles controlled_timeout / failure without throwing", () => {
      const idx = f.indexOf('action === "drive_read"');
      expect(idx).toBeGreaterThan(-1);
      const slice = f.slice(idx, idx + 2500);
      expect(slice).toMatch(/controlled_timeout/);
      expect(slice).toMatch(/Drive teď nedostupný/);
      // The block must not throw on failure (no `throw new Error` for the
      // !res.ok / missing content case).
      expect(slice).not.toMatch(/throw new Error\(data\?\.error/);
    });
  });
});
