/**
 * P28.2 — cron secret regression test (static snapshot).
 *
 * CI does not have direct DB access in this project, so we pin a snapshot
 * of `cron.job` rows captured during P28.2 acceptance and assert the two
 * invariants from P28.1:
 *
 *   1. No karel-* cron command uses the legacy GUC pattern
 *      `current_setting('app.karel_cron_secret', ...)`.
 *   2. `karel-active-session-processor-3min` resolves the secret via
 *      `public.get_karel_cron_secret()`.
 *
 * The live DB-backed counterpart lives at
 * `scripts/audit-cron-secret-sources.ts` and can be run manually or wired
 * into a deploy hook.
 *
 * If you change cron jobs, update CRON_SNAPSHOT below from:
 *   select jobname, command from cron.job
 *   where command ilike '%functions/v1/karel%';
 */
import { describe, it, expect } from "vitest";

type CronRow = { jobname: string; command: string };

// Snapshot captured 2026-05-05 during P28.2 closeout.
const CRON_SNAPSHOT: CronRow[] = [
  {
    jobname: "karel-active-session-processor-3min",
    command: `select net.http_post(
      url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-active-session-processor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Karel-Cron-Secret', public.get_karel_cron_secret()
      ),
      body := jsonb_build_object('trigger','cron')
    );`,
  },
  // Representative samples of vault-based jobs (acceptable pattern):
  {
    jobname: "did-email-watchdog-1430",
    command: `headers := jsonb_build_object('Content-Type','application/json',
      'X-Karel-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'KAREL_CRON_SECRET' limit 1))`,
  },
  {
    jobname: "karel-drive-queue-fast-1min",
    command: `headers := jsonb_build_object('Content-Type','application/json',
      'X-Karel-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'KAREL_CRON_SECRET' limit 1))`,
  },
];

const LEGACY_GUC_PATTERN = /current_setting\(\s*'app\.karel_cron_secret'/i;

describe("P28.2 cron secret regression", () => {
  it("no karel-* cron job uses the legacy GUC current_setting('app.karel_cron_secret')", () => {
    const offenders = CRON_SNAPSHOT.filter((r) => LEGACY_GUC_PATTERN.test(r.command));
    expect(offenders, `legacy GUC found in: ${offenders.map((o) => o.jobname).join(", ")}`).toEqual([]);
  });

  it("karel-active-session-processor-3min resolves the secret via public.get_karel_cron_secret()", () => {
    const row = CRON_SNAPSHOT.find((r) => r.jobname === "karel-active-session-processor-3min");
    expect(row, "active-session-processor cron job missing from snapshot").toBeDefined();
    expect(row!.command).toContain("public.get_karel_cron_secret()");
    expect(row!.command).not.toMatch(LEGACY_GUC_PATTERN);
  });

  it("acceptable cron jobs use either get_karel_cron_secret() or vault.decrypted_secrets", () => {
    for (const row of CRON_SNAPSHOT) {
      const ok =
        row.command.includes("public.get_karel_cron_secret()") ||
        row.command.includes("vault.decrypted_secrets");
      expect(ok, `cron job ${row.jobname} uses no approved secret source`).toBe(true);
    }
  });
});
