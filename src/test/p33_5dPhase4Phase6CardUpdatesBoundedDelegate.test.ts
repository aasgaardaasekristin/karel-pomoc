/**
 * P33.5D — phase4_card_profiling and phase6_card_autoupdate must use a true
 * bounded delegate path. The delegate run-daily-card-updates must run its
 * bounded handler BEFORE any Drive token / AI call / unbounded card loop,
 * and the phase-worker must send the exact bounded body.
 *
 * Source-level guards only — no live HTTP.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const phaseWorkerSrc = readFileSync(
  resolve(__dirname, "../../supabase/functions/karel-did-daily-cycle-phase-worker/index.ts"),
  "utf-8",
);
const cardUpdatesSrc = readFileSync(
  resolve(__dirname, "../../supabase/functions/run-daily-card-updates/index.ts"),
  "utf-8",
);

describe("P33.5D — run-daily-card-updates bounded delegate is first-class", () => {
  it("returns p33_5d_bounded_confirmed in bounded responses", () => {
    expect(cardUpdatesSrc).toMatch(/p33_5d_bounded_confirmed:\s*true/);
  });

  it("bounded branch appears before any getAccessToken call", () => {
    const boundedIdx = cardUpdatesSrc.indexOf("phase_worker_bounded");
    const tokenIdx = cardUpdatesSrc.indexOf("getAccessToken");
    expect(boundedIdx).toBeGreaterThan(0);
    expect(tokenIdx).toBeGreaterThan(0);
    expect(boundedIdx).toBeLessThan(tokenIdx);
  });

  it("bounded branch appears before resolveKartotekaRoot (Drive)", () => {
    const boundedIdx = cardUpdatesSrc.indexOf("phase_worker_bounded");
    const driveIdx = cardUpdatesSrc.indexOf("resolveKartotekaRoot");
    expect(driveIdx).toBeGreaterThan(0);
    expect(boundedIdx).toBeLessThan(driveIdx);
  });

  it("bounded branch returns controlled_skipped or accepted_async (no synchronous full card loop)", () => {
    expect(cardUpdatesSrc).toMatch(/outcome:\s*"controlled_skipped"/);
    expect(cardUpdatesSrc).toMatch(/outcome:\s*"accepted_async"/);
  });
});

describe("P33.5D — phase-worker dispatch body for phase4/phase6", () => {
  it("uses boundedCardUpdateBody for phase4_card_profiling and phase6_card_autoupdate", () => {
    expect(phaseWorkerSrc).toMatch(/boundedCardUpdateBody/);
    // both kinds map to run-daily-card-updates with the bounded card body
    const phase4Block = phaseWorkerSrc.match(/case\s+"phase4_card_profiling":[\s\S]{0,300}/);
    const phase6Block = phaseWorkerSrc.match(/case\s+"phase6_card_autoupdate":[\s\S]{0,300}/);
    expect(phase4Block?.[0]).toMatch(/boundedCardUpdateBody/);
    expect(phase6Block?.[0]).toMatch(/boundedCardUpdateBody/);
  });

  it("BOUNDED_DELEGATE_BUDGET_MS is 45_000", () => {
    expect(phaseWorkerSrc).toMatch(/BOUNDED_DELEGATE_BUDGET_MS\s*=\s*45_000/);
  });

  it("bounded body declares phase_worker_bounded:true and timeout_budget_ms BOUNDED_DELEGATE_BUDGET_MS", () => {
    expect(phaseWorkerSrc).toMatch(/phase_worker_bounded:\s*true/);
    expect(phaseWorkerSrc).toMatch(/timeout_budget_ms:\s*BOUNDED_DELEGATE_BUDGET_MS/);
  });

  it("card-update body sets p33_5d_card_updates_bounded:true", () => {
    expect(phaseWorkerSrc).toMatch(/p33_5d_card_updates_bounded:\s*true/);
  });

  it("no legacy p29b_phase_worker_phase6 source remains as the card-update body source", () => {
    // run-daily-card-updates dispatch must not use the legacy literal.
    const phase6Block = phaseWorkerSrc.match(/case\s+"phase6_card_autoupdate":[\s\S]{0,300}/);
    expect(phase6Block?.[0]).not.toMatch(/p29b_phase_worker_phase6/);
  });

  it("DB transport timeout for phase4/phase6 is 55_000 (under pg_net 60s ceiling)", () => {
    expect(phaseWorkerSrc).toMatch(/phase4_card_profiling:\s*55_000/);
    expect(phaseWorkerSrc).toMatch(/phase6_card_autoupdate:\s*55_000/);
  });

  it("stores delegate_request_body_preview and p33_5d_bounded_confirmed in job result", () => {
    expect(phaseWorkerSrc).toMatch(/delegate_request_body_preview/);
    expect(phaseWorkerSrc).toMatch(/p33_5d_bounded_confirmed:/);
  });

  it("polls pg_net responses through the SECURITY DEFINER RPC (not .schema(\"net\"))", () => {
    expect(phaseWorkerSrc).toMatch(/did_get_pg_net_response/);
    // The old direct schema path must no longer be used for response reads.
    expect(phaseWorkerSrc).not.toMatch(/\.schema\("net"\)\s*\.from\("_http_response"\)/);
  });

  it("maps controlled_skipped to controlled_skipped and other 2xx to completed", () => {
    expect(phaseWorkerSrc).toMatch(/downstreamOutcome === "controlled_skipped" \? "controlled_skipped" : "completed"/);
  });
});
