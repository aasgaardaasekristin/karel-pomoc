/**
 * P33.5B — phase-worker delegate auth propagation.
 *
 * Pinned contracts:
 *   - phase-worker.callEdgeFunction sends BOTH service-role bearer
 *     and X-Karel-Cron-Secret on every downstream HTTP delegate.
 *   - the four previously-401 delegate targets accept either path.
 *   - downstream config has verify_jwt=false so the platform gateway
 *     does not intercept service-role bearer with 401.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");
const phaseWorkerSrc = readFileSync(
  resolve(root, "supabase/functions/karel-did-daily-cycle-phase-worker/index.ts"),
  "utf8",
);
const helperSrc = readFileSync(
  resolve(root, "supabase/functions/_shared/internalEdgeAuth.ts"),
  "utf8",
);
const configToml = readFileSync(resolve(root, "supabase/config.toml"), "utf8");
const cardUpdatesSrc = readFileSync(
  resolve(root, "supabase/functions/run-daily-card-updates/index.ts"),
  "utf8",
);
const pantrySrc = readFileSync(
  resolve(root, "supabase/functions/karel-pantry-flush-to-drive/index.ts"),
  "utf8",
);
const driveQueueSrc = readFileSync(
  resolve(root, "supabase/functions/karel-drive-queue-processor/index.ts"),
  "utf8",
);

describe("P33.5B internalEdgeAuth helper", () => {
  it("exports buildInternalEdgeHeaders + getKarelCronSecret", () => {
    expect(helperSrc).toMatch(/export async function buildInternalEdgeHeaders/);
    expect(helperSrc).toMatch(/export async function getKarelCronSecret/);
  });
  it("emits Authorization Bearer service key when present", () => {
    expect(helperSrc).toMatch(/Authorization.*Bearer \$\{serviceKey\}/);
  });
  it("emits X-Karel-Cron-Secret header when secret present", () => {
    expect(helperSrc).toMatch(/X-Karel-Cron-Secret/);
  });
  it("does not console.log secret values", () => {
    expect(helperSrc).not.toMatch(/console\.\w+\([^)]*serviceKey/);
    expect(helperSrc).not.toMatch(/console\.\w+\([^)]*cronSecret/);
  });
});

describe("P33.5B phase-worker delegate auth", () => {
  it("imports the shared internal-edge-auth helper", () => {
    expect(phaseWorkerSrc).toMatch(/from "\.\.\/_shared\/internalEdgeAuth\.ts"/);
    expect(phaseWorkerSrc).toMatch(/buildInternalEdgeHeaders/);
  });

  it("callEdgeFunction uses buildInternalEdgeHeaders, not a hardcoded bearer-only object", () => {
    const callFn = phaseWorkerSrc.match(/async function callEdgeFunction[\s\S]*?\n\}/);
    expect(callFn).toBeTruthy();
    const body = callFn![0];
    expect(body).toMatch(/buildInternalEdgeHeaders/);
    // No raw `Authorization: \`Bearer \${SERVICE_KEY}\`` literal in
    // the headers object — must come from the helper.
    expect(body).not.toMatch(/headers:\s*\{\s*Authorization:\s*`Bearer \$\{SERVICE_KEY\}`/);
  });

  it("only one fetch(functions/v1/...) call site exists, inside callEdgeFunction", () => {
    const matches = phaseWorkerSrc.match(/fetch\([^)]*functions\/v1/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);
  });

  it("dispatchTarget covers all four previously-401 job kinds", () => {
    expect(phaseWorkerSrc).toMatch(/case "phase4_card_profiling"/);
    expect(phaseWorkerSrc).toMatch(/case "phase6_card_autoupdate"/);
    expect(phaseWorkerSrc).toMatch(/case "phase8b_pantry_flush"/);
    expect(phaseWorkerSrc).toMatch(/case "phase9_drive_queue_flush"/);
  });
});

describe("P33.5B downstream functions accept internal auth and drop gateway JWT gate", () => {
  const targets = [
    "run-daily-card-updates",
    "karel-pantry-flush-to-drive",
    "karel-drive-queue-processor",
    "update-operative-plan",
    "karel-daily-therapist-intelligence",
  ];
  for (const t of targets) {
    it(`config.toml has [functions.${t}] verify_jwt = false`, () => {
      const re = new RegExp(`\\[functions\\.${t}\\][\\s\\S]{0,80}verify_jwt\\s*=\\s*false`);
      expect(configToml).toMatch(re);
    });
  }

  it("run-daily-card-updates accepts X-Karel-Cron-Secret in addition to service bearer", () => {
    expect(cardUpdatesSrc).toMatch(/X-Karel-Cron-Secret/);
    expect(cardUpdatesSrc).toMatch(/verify_karel_cron_secret/);
  });

  it("pantry-flush continues to accept X-Karel-Cron-Secret", () => {
    expect(pantrySrc).toMatch(/X-Karel-Cron-Secret/);
    expect(pantrySrc).toMatch(/verify_karel_cron_secret/);
  });

  it("drive-queue-processor continues to accept X-Karel-Cron-Secret", () => {
    expect(driveQueueSrc).toMatch(/X-Karel-Cron-Secret/);
    expect(driveQueueSrc).toMatch(/verify_karel_cron_secret/);
  });

  it("downstream gates still 401 unauthenticated requests", () => {
    expect(pantrySrc).toMatch(/Unauthorized/);
    expect(driveQueueSrc).toMatch(/Unauthorized/);
  });
});
