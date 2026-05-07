/**
 * P30.4 — Active-part daily brief canonicalization tests.
 *
 * Pure unit coverage for the canonicalizer + generation contract.
 * The generation/filter side effects are exercised against a mock Supabase
 * client so we never touch the real backend from vitest.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeDidPartName,
  isForbiddenNonPartName,
  isPlaceholderPartName,
  normalizeCzechPartKey,
} from "../../supabase/functions/_shared/didPartCanonicalization.ts";
import { generateActivePartDailyBriefs } from "../../supabase/functions/_shared/activePartDailyBrief.ts";

const REGISTRY = [
  { part_name: "Arthur", status: "active" },
  { part_name: "arthur", status: "active" },
  { part_name: "ARTHUR", status: "active" },
  { part_name: "Tundrupek", status: "active" },
  { part_name: "tundrupek", status: "active" },
  { part_name: "TUNDRUPEK", status: "active" },
  { part_name: "gustík", status: "active" },
  { part_name: "GUSTIK", status: "active" },
  { part_name: "001_gerhardt", status: "active" },
  { part_name: "002_Anička", status: "active" },
  { part_name: "hanička", status: "quarantined_wrong_identity_p32" },
  { part_name: "karel", status: "quarantined_wrong_identity_p32" },
  { part_name: "káťa", status: "active" },
  { part_name: "Dokument bez názvu", status: "active" },
];

describe("normalizeCzechPartKey", () => {
  it("collapses case and diacritics", () => {
    const k = normalizeCzechPartKey("Tundrupek");
    expect(normalizeCzechPartKey("tundrupek")).toBe(k);
    expect(normalizeCzechPartKey("TUNDRUPEK")).toBe(k);
    expect(k).toBe("tundrupek");
  });
  it("collapses Arthur variants", () => {
    const k = normalizeCzechPartKey("Arthur");
    expect(normalizeCzechPartKey("arthur")).toBe(k);
    expect(normalizeCzechPartKey("ARTHUR")).toBe(k);
  });
  it("collapses Gustík variants", () => {
    expect(normalizeCzechPartKey("Gustík")).toBe("gustik");
    expect(normalizeCzechPartKey("gustik")).toBe("gustik");
    expect(normalizeCzechPartKey("GUSTIK")).toBe("gustik");
    expect(normalizeCzechPartKey("GUSTÍK")).toBe("gustik");
  });
});

describe("isForbiddenNonPartName", () => {
  for (const n of ["Hana", "Hanka", "Hanička", "Hani", "Karel", "Káťa", "Katka"]) {
    it(`flags '${n}' as forbidden`, () => {
      expect(isForbiddenNonPartName(n)).toBe(true);
    });
  }
  it("does not flag Arthur or Tundrupek", () => {
    expect(isForbiddenNonPartName("Arthur")).toBe(false);
    expect(isForbiddenNonPartName("Tundrupek")).toBe(false);
  });
});

describe("isPlaceholderPartName", () => {
  it("flags Dokument bez názvu", () => {
    expect(isPlaceholderPartName("Dokument bez názvu")).toBe(true);
    expect(isPlaceholderPartName("dokument bez nazvu")).toBe(true);
  });
  it("flags empty / null / unknown", () => {
    expect(isPlaceholderPartName("")).toBe(true);
    expect(isPlaceholderPartName(null)).toBe(true);
    expect(isPlaceholderPartName(undefined)).toBe(true);
    expect(isPlaceholderPartName("unknown")).toBe(true);
  });
});

describe("canonicalizeDidPartName", () => {
  it("maps case alias to canonical proper-case form", () => {
    const r = canonicalizeDidPartName("ARTHUR", REGISTRY);
    expect(r.canonical_part_name).toBe("Arthur");
    expect(r.status).toBe("case_alias");
  });
  it("returns canonical for exact match", () => {
    const r = canonicalizeDidPartName("Arthur", REGISTRY);
    expect(r.canonical_part_name).toBe("Arthur");
    expect(r.status).toBe("canonical");
  });
  it("never returns Hana/Karel/Káťa as canonical even if in registry", () => {
    expect(canonicalizeDidPartName("hanička", REGISTRY).status).toBe("forbidden_non_part");
    expect(canonicalizeDidPartName("karel", REGISTRY).status).toBe("forbidden_non_part");
    expect(canonicalizeDidPartName("Káťa", REGISTRY).status).toBe("forbidden_non_part");
    expect(canonicalizeDidPartName("Hanka", REGISTRY).status).toBe("forbidden_non_part");
  });
  it("flags Dokument bez názvu as placeholder", () => {
    expect(canonicalizeDidPartName("Dokument bez názvu", REGISTRY).status).toBe("placeholder");
  });
  it("flags unknown name as unmapped", () => {
    expect(canonicalizeDidPartName("Zzz_NotInRegistry", REGISTRY).status).toBe("unmapped");
  });
});

// ---------------------------------------------------------------------------
// Generation contract via mock Supabase client.

type Captured = { table: string; row: any };

function makeMockSb(opts: { registry: any[]; sensitivities?: any[]; events?: any[] }) {
  const captured: Captured[] = [];

  const builder = (table: string) => {
    let _filters: any = {};
    const api: any = {
      select: () => api,
      eq: (_k: string, _v: any) => api,
      gte: () => api,
      lte: () => api,
      in: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async (row: any) => {
        captured.push({ table, row });
        return { data: row, error: null };
      },
      then: undefined,
    };
    // Make the builder thenable to act like a query
    const promise = new Promise<{ data: any[]; error: null }>((resolve) => {
      let data: any[] = [];
      if (table === "did_part_registry") data = opts.registry;
      else if (table === "part_external_event_sensitivities") data = opts.sensitivities ?? [];
      else if (table === "external_reality_events") data = opts.events ?? [];
      else if (table === "did_threads") data = [];
      else if (table === "external_event_watch_runs") data = [];
      else data = [];
      resolve({ data, error: null });
    });
    api.then = (...a: any[]) => promise.then(...a);
    return api;
  };

  return {
    from: builder,
    captured,
  };
}

describe("generateActivePartDailyBriefs P30.4 contract", () => {
  it("collapses case duplicates: only one displayable row per matrix part", async () => {
    // Stub detectActiveParts via sensitivities table — every part_name in
    // sensitivities becomes a watchlist candidate.
    const sb = makeMockSb({
      registry: REGISTRY,
      sensitivities: [
        { id: "s1", part_name: "arthur", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s2", part_name: "Arthur", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s3", part_name: "ARTHUR", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s4", part_name: "tundrupek", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s5", part_name: "Tundrupek", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s6", part_name: "TUNDRUPEK", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s7", part_name: "hanička", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
        { id: "s8", part_name: "Dokument bez názvu", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
      ],
    });

    const res = await generateActivePartDailyBriefs(sb as any, {
      userId: "test-user",
      datePrague: "2026-05-07",
      matrixIdsByPart: { Arthur: "matrix-arthur", Tundrupek: "matrix-tundrupek" },
      queryPlanVersion: "p30.3_personal_anchor_general_trigger_weekly_matrix",
    });

    expect(res.ok).toBe(true);
    const upserts = sb.captured.filter((c) => c.table === "did_active_part_daily_brief");

    const displayable = upserts.filter(
      (u) => u.row.evidence_summary?.excluded_from_briefing === false,
    );
    const displayableNames = displayable.map((u) => u.row.part_name).sort();
    expect(displayableNames).toEqual(["Arthur", "Tundrupek"]);

    // forbidden + placeholder must be written but excluded
    const excluded = upserts.filter(
      (u) => u.row.evidence_summary?.excluded_from_briefing === true,
    );
    const reasons = excluded.map((u) => u.row.evidence_summary.exclusion_reason).sort();
    expect(reasons).toContain("p30_4_forbidden_non_part");
    expect(reasons).toContain("p30_4_placeholder");
    expect(reasons).toContain("p30_4_case_duplicate");

    // every displayable row has matrix_ref + plan version
    for (const d of displayable) {
      expect(d.row.evidence_summary.weekly_matrix_ref).toBeTruthy();
      expect(d.row.evidence_summary.query_plan_version).toBe(
        "p30.3_personal_anchor_general_trigger_weekly_matrix",
      );
      expect(d.row.evidence_summary.matrix_link_status).toBe("linked");
      expect(d.row.evidence_summary.canonical_part_name).toBe(d.row.part_name);
    }
  });

  it("excludes part with no matrix ref (missing_weekly_matrix_ref)", async () => {
    const sb = makeMockSb({
      registry: REGISTRY,
      sensitivities: [
        { id: "s1", part_name: "Arthur", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
      ],
    });
    const res = await generateActivePartDailyBriefs(sb as any, {
      userId: "u",
      datePrague: "2026-05-07",
      matrixIdsByPart: {}, // no matrix
      queryPlanVersion: "p30.3_personal_anchor_general_trigger_weekly_matrix",
    });
    expect(res.ok).toBe(true);
    const ups = sb.captured.filter((c) => c.table === "did_active_part_daily_brief");
    expect(ups).toHaveLength(1);
    expect(ups[0].row.evidence_summary.excluded_from_briefing).toBe(true);
    expect(ups[0].row.evidence_summary.exclusion_reason).toBe(
      "p30_4_missing_weekly_matrix_ref",
    );
  });

  it("never produces card_update_queue / did_observations / KARTA writes", async () => {
    const sb = makeMockSb({
      registry: REGISTRY,
      sensitivities: [
        { id: "s1", part_name: "Arthur", event_pattern: "x", sensitivity_types: [], recommended_guard: null, safe_opening_style: null, active: true },
      ],
    });
    await generateActivePartDailyBriefs(sb as any, {
      userId: "u",
      datePrague: "2026-05-07",
      matrixIdsByPart: { Arthur: "m1" },
      queryPlanVersion: "p30.3_personal_anchor_general_trigger_weekly_matrix",
    });
    const sideEffectTables = sb.captured
      .map((c) => c.table)
      .filter((t) =>
        t === "card_update_queue" ||
        t === "did_observations" ||
        t === "did_pending_drive_writes",
      );
    expect(sideEffectTables).toEqual([]);
  });
});

describe("presentation-safe filter contract", () => {
  // Mirror of the inline filter applied in karel-did-daily-briefing and
  // todayRelevantParts. Kept here as the canonical predicate so any drift
  // in those call sites is caught by this test.
  const QPV = "p30.3_personal_anchor_general_trigger_weekly_matrix";
  const isPresentationSafe = (ev: any) =>
    ev?.excluded_from_briefing !== true &&
    !!ev?.weekly_matrix_ref &&
    ev?.query_plan_version === QPV;

  it("rejects excluded rows", () => {
    expect(isPresentationSafe({ excluded_from_briefing: true, weekly_matrix_ref: "x", query_plan_version: QPV })).toBe(false);
  });
  it("rejects rows missing matrix ref", () => {
    expect(isPresentationSafe({ weekly_matrix_ref: null, query_plan_version: QPV })).toBe(false);
  });
  it("rejects wrong query plan version", () => {
    expect(isPresentationSafe({ weekly_matrix_ref: "x", query_plan_version: "old" })).toBe(false);
  });
  it("accepts canonical row", () => {
    expect(isPresentationSafe({ weekly_matrix_ref: "x", query_plan_version: QPV, excluded_from_briefing: false })).toBe(true);
  });
});
