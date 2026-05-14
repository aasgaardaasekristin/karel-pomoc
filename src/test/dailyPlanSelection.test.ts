/**
 * Tests pro Část 1 (Scénář D fix) — selekce kanonického dnešního plánu.
 * T1–T5 přesně dle navrženého plánu + T-tie doplňkový tie-break.
 * T6 (DB canonical) zatím NEpřipraven — odložen na Část 2.
 */

import { describe, it, expect } from "vitest";
import {
  selectCanonicalPlan,
  getPlanSourceStatus,
  getPlanQualityScore,
  getGroundingTokenCount,
  PlanLikeRow,
} from "@/lib/dailyPlanSelection";

const groundedRow = (
  id: string,
  created_at: string,
  tokens: string[] = ["timmy", "velryba"],
): PlanLikeRow => ({
  id,
  created_at,
  plan_markdown: "stabilizing markdown",
  urgency_breakdown: {
    playroom_plan: {
      therapeutic_program: [
        { block: 1, play_metaphor: "x" },
        { block: 2, play_metaphor: "y" },
      ],
      meta: { source_status: "grounded", grounding_tokens_available: tokens },
    },
  },
});

const fallbackRow = (id: string, created_at: string): PlanLikeRow => ({
  id,
  created_at,
  plan_markdown: "stabilizing markdown",
  urgency_breakdown: {
    playroom_plan: {
      therapeutic_program: [{ block: 1 }],
      meta: { source_status: "fallback", grounding_tokens_available: [] },
    },
  },
});

const manualEmptyRow = (id: string, created_at: string): PlanLikeRow => ({
  id,
  created_at,
  plan_markdown: "obecná stabilizační šablona",
  urgency_breakdown: {},
});

const legacyRow = (id: string, created_at: string): PlanLikeRow => ({
  id,
  created_at,
  plan_markdown: "",
  urgency_breakdown: {
    playroom_plan: {
      therapeutic_program: [{ block: 1 }],
      // BEZ meta.source_status — legacy
    },
  },
});

describe("selectCanonicalPlan — Scénář D", () => {
  it("T1: grounded řádek přebije novější manual prázdný řádek", () => {
    const grounded = groundedRow("g1", "2026-05-13T21:12:37Z");
    const empty = manualEmptyRow("m1", "2026-05-13T21:14:14Z");
    const winner = selectCanonicalPlan([empty, grounded]);
    expect(winner?.id).toBe("g1");
  });

  it("T2: pouze manual řádek bez playroom_plan → vybere se on (s markdown_only badge)", () => {
    const empty = manualEmptyRow("m1", "2026-05-13T21:14:14Z");
    const winner = selectCanonicalPlan([empty]);
    expect(winner?.id).toBe("m1");
    expect(getPlanSourceStatus(winner!)).toBe("markdown_only");
  });

  it("T3: grounded vs fallback (oba s therapeutic_program) → grounded vyhrává i když je starší", () => {
    const grounded = groundedRow("g1", "2026-05-13T10:00:00Z");
    const fb = fallbackRow("f1", "2026-05-13T20:00:00Z");
    const winner = selectCanonicalPlan([fb, grounded]);
    expect(winner?.id).toBe("g1");
    expect(getPlanSourceStatus(winner!)).toBe("grounded");
  });

  it("T4: legacy řádek bez meta.source_status klasifikován jako legacy_unknown, ne grounded", () => {
    const legacy = legacyRow("l1", "2026-05-13T12:00:00Z");
    expect(getPlanSourceStatus(legacy)).toBe("legacy_unknown");
    // a má nižší skóre než skutečný grounded
    const grounded = groundedRow("g1", "2026-05-13T10:00:00Z");
    expect(getPlanQualityScore(grounded)).toBeGreaterThan(
      getPlanQualityScore(legacy),
    );
  });

  it("T5: prázdný vstup vrátí null", () => {
    expect(selectCanonicalPlan([])).toBeNull();
  });

  it("T-tie: dva grounded řádky se shodným obsahem — vyhrává novější created_at", () => {
    const older = groundedRow("g_old", "2026-05-13T10:00:00Z");
    const newer = groundedRow("g_new", "2026-05-13T18:00:00Z");
    const winner = selectCanonicalPlan([older, newer]);
    expect(winner?.id).toBe("g_new");
  });

  it("getGroundingTokenCount vrací správný počet tokenů", () => {
    const g = groundedRow("g1", "2026-05-13T10:00:00Z", ["a", "b", "c"]);
    expect(getGroundingTokenCount(g)).toBe(3);
    expect(getGroundingTokenCount(manualEmptyRow("m1", "x"))).toBe(0);
  });
});
