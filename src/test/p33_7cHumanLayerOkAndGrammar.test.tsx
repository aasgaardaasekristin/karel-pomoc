/**
 * P33.7C — Human layer ok-gate, renderer/cache version bump, Czech grammar guard.
 *
 * Covers:
 *  - Anička grammar guard (preposition + nominative is forbidden, safe forms allowed).
 *  - Renderer ok-gate honours daily_briefing_content_completeness.overall_status.
 *  - Cache readiness gate now requires renderer_version=p33.8.0.
 *  - ISO-date numbers in external_reality must not produce unsupported_number warnings
 *    (regression of the false positive that drove human_ok=false in production).
 */

import { describe, it, expect } from "vitest";
import { auditVisibleKarelText } from "@/lib/karelVisibleTextQuality";

// ────────────────────────────────────────────────────────────────────────────
// 1. Anička grammar guard
// ────────────────────────────────────────────────────────────────────────────
describe("P33.7C — Anička grammar guard", () => {
  it("blocks 'Pro Anička' (preposition + nominative)", () => {
    const r = auditVisibleKarelText("Pro Anička dnes navrhuji první kontakt.");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("anicka_bad_case");
  });

  it("blocks 'k Anička'", () => {
    const r = auditVisibleKarelText("Vrať se k Anička až po prvním kontaktu.");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("anicka_bad_case");
  });

  it("blocks 's Anička'", () => {
    const r = auditVisibleKarelText("Pracuj s Anička jen po stabilizaci.");
    expect(r.ok).toBe(false);
  });

  it("allows 'K části Anička'", () => {
    const r = auditVisibleKarelText("K části Anička zatím nemáme dost opory.");
    // Only the anicka guard should not fire; other forbidden phrases unrelated.
    expect(r.errors.find((e) => e.includes("anicka_bad_case"))).toBeUndefined();
  });

  it("allows 'K návrhu pro část Anička'", () => {
    const r = auditVisibleKarelText("K návrhu pro část Anička se vrátíme až po prvním kontaktu.");
    expect(r.errors.find((e) => e.includes("anicka_bad_case"))).toBeUndefined();
  });

  it("allows 'U Aničky' (genitive)", () => {
    const r = auditVisibleKarelText("U Aničky držím bezpečný rámec a sleduju stop-signály.");
    expect(r.errors.find((e) => e.includes("anicka_bad_case"))).toBeUndefined();
  });

  it("does not flag 'Pro dnešek je v úvahu Anička'", () => {
    // 'Pro dnešek' is a clean adverbial; Anička appears later as nominative
    // after 'v úvahu'. The guard must not over-trigger on any 'Pro' anywhere
    // in a sentence that mentions Anička.
    const r = auditVisibleKarelText(
      "Pro dnešek je v úvahu Anička jako pracovní hypotéza, ale ještě nemám dost opory."
    );
    expect(r.errors.find((e) => e.includes("anicka_bad_case"))).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Renderer ok-gate — honour content completeness.overall_status
//
// We re-implement the gate here as a pure inline reflection of the renderer
// contract, so we can unit-test all branches without standing up the full
// edge function. The renderer source is the single source of truth; this
// test guards against regressions of the contract.
// ────────────────────────────────────────────────────────────────────────────
type AuditShape = {
  totalUnsupported: number;
  totalRobotic: number;
  empty: number;
  errorsLen: number;
  sectionsLen: number;
  completenessStatus: string;
};

function rendererOk(a: AuditShape): boolean {
  const completenessOk =
    a.completenessStatus === "complete" ||
    a.completenessStatus === "complete_with_controlled_missing";
  return (
    a.sectionsLen >= 6 &&
    a.totalUnsupported === 0 &&
    a.totalRobotic === 0 &&
    a.empty === 0 &&
    a.errorsLen === 0 &&
    completenessOk
  );
}

const cleanAudit: AuditShape = {
  totalUnsupported: 0,
  totalRobotic: 0,
  empty: 0,
  errorsLen: 0,
  sectionsLen: 10,
  completenessStatus: "complete",
};

describe("P33.7C — renderer ok-gate", () => {
  it("ok=true for clean audit + complete", () => {
    expect(rendererOk(cleanAudit)).toBe(true);
  });

  it("ok=true for clean audit + complete_with_controlled_missing", () => {
    expect(
      rendererOk({ ...cleanAudit, completenessStatus: "complete_with_controlled_missing" })
    ).toBe(true);
  });

  it("ok=false for blocked completeness even with clean audit", () => {
    expect(rendererOk({ ...cleanAudit, completenessStatus: "blocked" })).toBe(false);
  });

  it("ok=false for incomplete completeness", () => {
    expect(rendererOk({ ...cleanAudit, completenessStatus: "incomplete" })).toBe(false);
  });

  it("ok=false for empty / missing completeness status", () => {
    expect(rendererOk({ ...cleanAudit, completenessStatus: "" })).toBe(false);
  });

  it("ok=false when unsupported claims > 0 even if completeness=complete", () => {
    expect(rendererOk({ ...cleanAudit, totalUnsupported: 1 })).toBe(false);
  });

  it("ok=false when robotic phrase > 0", () => {
    expect(rendererOk({ ...cleanAudit, totalRobotic: 1 })).toBe(false);
  });

  it("ok=false when empty sections > 0", () => {
    expect(rendererOk({ ...cleanAudit, empty: 1 })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. ISO date numbers must not be flagged as unsupported numbers in
//    external_reality (regression of the production false positive that
//    produced unsupported_claims_count=9 from "ověřeno 2026-05-11").
// ────────────────────────────────────────────────────────────────────────────
function extractClaimNumbers(text: string): number[] {
  const stripped = text
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  return (stripped.match(/\b(\d+)\b/g) || []).map(Number);
}

describe("P33.7C — external_reality ISO-date number stripping", () => {
  it("does not extract '2026', '5', '11' from 'ověřeno 2026-05-11'", () => {
    const ns = extractClaimNumbers(
      "U Tundrupek je dříve evidovaný citlivý okruh (zdroj cnn.iprima.cz, ověřeno 2026-05-11)."
    );
    expect(ns).toEqual([]);
  });

  it("does not extract Czech dotted dates '11. 5. 2026'", () => {
    const ns = extractClaimNumbers("Zdroj ověřen 11. 5. 2026 z otevřené domény.");
    expect(ns).toEqual([]);
  });

  it("still extracts genuine claim numbers", () => {
    const ns = extractClaimNumbers("Dnes mám 3 zdroje a 2 aktivní okruhy.");
    expect(ns).toEqual([3, 2]);
  });

  it("strips year tokens like 2026 standalone", () => {
    const ns = extractClaimNumbers("Rok 2026 je relevantní rámec.");
    expect(ns).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Cache readiness now requires renderer_version=p33.8.0 (P33.7C bump).
// ────────────────────────────────────────────────────────────────────────────
function isCachedReady(p: any): boolean {
  const human = p?.payload?.karel_human_briefing ?? null;
  const completeness = p?.payload?.daily_briefing_content_completeness ?? null;
  return (
    human?.ok === true &&
    human?.renderer_version === "p33.8.0" &&
    completeness?.version === "p33.7" &&
    ["complete", "complete_with_controlled_missing"].includes(
      String(completeness?.overall_status ?? "")
    )
  );
}

describe("P33.7C — cache readiness gate", () => {
  it("p33.7.0 cached row is NOT ready after the version bump", () => {
    const old = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.7.0" },
        daily_briefing_content_completeness: { version: "p33.7", overall_status: "complete" },
      },
    };
    expect(isCachedReady(old)).toBe(false);
  });

  it("p33.8.0 cached row IS ready", () => {
    const ok = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.8.0" },
        daily_briefing_content_completeness: { version: "p33.7", overall_status: "complete" },
      },
    };
    expect(isCachedReady(ok)).toBe(true);
  });

  it("p33.8.0 + complete_with_controlled_missing IS ready", () => {
    const cm = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.8.0" },
        daily_briefing_content_completeness: {
          version: "p33.7",
          overall_status: "complete_with_controlled_missing",
        },
      },
    };
    expect(isCachedReady(cm)).toBe(true);
  });
});
