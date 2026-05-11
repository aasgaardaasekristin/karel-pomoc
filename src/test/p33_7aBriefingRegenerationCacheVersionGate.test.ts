import { describe, it, expect } from "vitest";

// Mirror of the edge function's force-flag detection and cache-readiness gate.
// Kept in sync with supabase/functions/karel-did-daily-briefing/index.ts (P33.7A).

const P33_7_FORCE_SOURCES = new Set([
  "p33_7_runtime_regen",
  "p33_7a_force_regen",
  "p33_7a_force_regen_runtime_proof",
  "p33_7_content_completeness",
]);

function isForceRegenerate(body: any): boolean {
  return (
    body?.force === true ||
    body?.forceRegenerate === true ||
    body?.force_regenerate === true ||
    body?.regenerate === true ||
    P33_7_FORCE_SOURCES.has(String(body?.source ?? ""))
  );
}

const REQUIRED_RENDERER_VERSION = "p33.7.1";
const REQUIRED_COMPLETENESS_VERSION = "p33.7";

function isCachedP337Ready(existing: any): boolean {
  const human = existing?.payload?.karel_human_briefing ?? null;
  const completeness = existing?.payload?.daily_briefing_content_completeness ?? null;
  return (
    human?.ok === true &&
    human?.renderer_version === REQUIRED_RENDERER_VERSION &&
    completeness?.version === REQUIRED_COMPLETENESS_VERSION &&
    ["complete", "complete_with_controlled_missing"].includes(
      String(completeness?.overall_status ?? "")
    )
  );
}

describe("P33.7A — force-flag compatibility", () => {
  it("force=true bypasses cache", () => {
    expect(isForceRegenerate({ force: true })).toBe(true);
  });
  it("forceRegenerate=true bypasses cache", () => {
    expect(isForceRegenerate({ forceRegenerate: true })).toBe(true);
  });
  it("force_regenerate=true bypasses cache", () => {
    expect(isForceRegenerate({ force_regenerate: true })).toBe(true);
  });
  it("regenerate=true bypasses cache", () => {
    expect(isForceRegenerate({ regenerate: true })).toBe(true);
  });
  it("source=p33_7a_force_regen_runtime_proof bypasses cache", () => {
    expect(isForceRegenerate({ source: "p33_7a_force_regen_runtime_proof" })).toBe(true);
  });
  it("empty body does NOT force", () => {
    expect(isForceRegenerate({})).toBe(false);
  });
});

describe("P33.7A — cache version gate", () => {
  const baseReady = {
    payload: {
      karel_human_briefing: { ok: true, renderer_version: "p33.7.1" },
      daily_briefing_content_completeness: {
        version: "p33.7",
        overall_status: "complete",
      },
    },
  };

  it("cached row with renderer_version=p31.1.0 is NOT ready", () => {
    const old = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p31.1.0" },
        daily_briefing_content_completeness: { version: "p33.7", overall_status: "complete" },
      },
    };
    expect(isCachedP337Ready(old)).toBe(false);
  });

  it("cached row missing daily_briefing_content_completeness is NOT ready", () => {
    const noCompleteness = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.7.0" },
      },
    };
    expect(isCachedP337Ready(noCompleteness)).toBe(false);
  });

  it("cached row with completeness.version != p33.7 is NOT ready", () => {
    const wrongVersion = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.7.0" },
        daily_briefing_content_completeness: { version: "p33.6", overall_status: "complete" },
      },
    };
    expect(isCachedP337Ready(wrongVersion)).toBe(false);
  });

  it("cached row with completeness overall_status=blocked is NOT ready", () => {
    const blocked = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.7.0" },
        daily_briefing_content_completeness: { version: "p33.7", overall_status: "blocked" },
      },
    };
    expect(isCachedP337Ready(blocked)).toBe(false);
  });

  it("cached row with renderer p33.7.1 + completeness p33.7 + complete IS ready", () => {
    expect(isCachedP337Ready(baseReady)).toBe(true);
  });

  it("cached row with overall_status=complete_with_controlled_missing IS ready", () => {
    const cm = {
      payload: {
        karel_human_briefing: { ok: true, renderer_version: "p33.7.1" },
        daily_briefing_content_completeness: {
          version: "p33.7",
          overall_status: "complete_with_controlled_missing",
        },
      },
    };
    expect(isCachedP337Ready(cm)).toBe(true);
  });

  it("cached row with karel_human_briefing.ok=false is NOT ready", () => {
    const notOk = {
      payload: {
        karel_human_briefing: { ok: false, renderer_version: "p33.7.0" },
        daily_briefing_content_completeness: { version: "p33.7", overall_status: "complete" },
      },
    };
    expect(isCachedP337Ready(notOk)).toBe(false);
  });
});
