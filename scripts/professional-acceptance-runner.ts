/**
 * P4: Professional Acceptance Runner — CLI.
 *
 * Spouští Vitest, vyhodnotí výstup jako client_evidence a posílá ho do edge
 * funkce `karel-acceptance-runner`, která provede SQL audit, sestaví
 * strukturovaný `AcceptanceRun` a perzistuje ho do `did_acceptance_runs`.
 *
 * Použití:
 *   bun run scripts/professional-acceptance-runner.ts P1
 *   bun run scripts/professional-acceptance-runner.ts P2_P3
 *   bun run scripts/professional-acceptance-runner.ts both
 *
 * Volby (env / CLI):
 *   ACCEPTANCE_RUNNER_AUTH_TOKEN=<JWT canonical user>   (povinné)
 *   --briefing=0  --herna=0  --team-delib=0  --live=0   (DOM proof čísla)
 *   --required-all-true=true                            (DOM required text)
 *   --skip-vitest                                       (přeskočí Vitest)
 *   --edge-helpers-present=true                         (CI ověřilo wiring)
 */

import { spawnSync } from "node:child_process";

type Pass = "P1" | "P2_P3";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "https://wpscavufytwucqemawwv.supabase.co";
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
const TOKEN = process.env.ACCEPTANCE_RUNNER_AUTH_TOKEN ?? "";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function maybeInt(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
function maybeBool(name: string): boolean | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

function runVitest(): boolean | undefined {
  if (flag("skip-vitest")) return undefined;
  console.log("→ Running Vitest…");
  const r = spawnSync("bunx", ["vitest", "run", "--reporter=basic"], {
    stdio: "inherit", encoding: "utf-8",
  });
  return r.status === 0;
}

async function callRunner(pass_name: Pass, client_evidence: Record<string, unknown>): Promise<void> {
  if (!TOKEN) throw new Error("ACCEPTANCE_RUNNER_AUTH_TOKEN is required");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/karel-acceptance-runner`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
      ...(ANON ? { apikey: ANON } : {}),
    },
    body: JSON.stringify({
      pass_name,
      client_evidence,
      app_version: process.env.GIT_COMMIT ?? null,
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ pass: pass_name, http: res.status, body }, null, 2));
  if (!res.ok || body?.run?.status !== "accepted") {
    process.exitCode = 1;
  }
}

async function main() {
  const which = (process.argv[2] ?? "both").toLowerCase();
  const testsPassed = runVitest();

  const baseEvidence = {
    tests_passed: testsPassed,
    edge_helpers_present: maybeBool("edge-helpers-present"),
  };

  const p1Evidence = {
    ...baseEvidence,
    briefing_dom_forbidden_count: maybeInt("briefing"),
    herna_modal_dom_forbidden_count: maybeInt("herna"),
    team_deliberation_modal_forbidden_count: maybeInt("team-delib"),
    live_session_dom_forbidden_count: maybeInt("live"),
    required_all_true: maybeBool("required-all-true"),
  };

  if (which === "p1" || which === "both") await callRunner("P1", p1Evidence);
  if (which === "p2_p3" || which === "both") await callRunner("P2_P3", baseEvidence);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
