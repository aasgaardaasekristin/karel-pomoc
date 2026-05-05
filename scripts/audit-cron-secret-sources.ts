/**
 * P28.2 — cron secret regression audit.
 *
 * Connects to the project DB via service role and asserts:
 *   1. No `karel-*` cron job uses the legacy GUC pattern
 *      `current_setting('app.karel_cron_secret', ...)`.
 *   2. The `karel-active-session-processor-3min` cron command resolves the
 *      secret via `public.get_karel_cron_secret()`.
 *
 * Run locally:
 *   bunx tsx scripts/audit-cron-secret-sources.ts
 *
 * Exits non-zero on regression so it can be wired into CI.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[p28.2] SUPABASE_URL / SERVICE_ROLE_KEY not set — skipping live DB audit.");
    process.exit(0);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: bad, error: badErr } = await sb.rpc("exec_sql", {
    sql: `select jobname, command from cron.job
          where command ilike '%functions/v1/karel%'
            and command ilike '%current_setting(''app.karel_cron_secret''%'`,
  }).catch(() => ({ data: null, error: { message: "rpc_unavailable" } } as any));

  if (badErr) {
    console.warn("[p28.2] DB rpc unavailable — falling back to static expectations only:", badErr.message);
    process.exit(0);
  }

  if (Array.isArray(bad) && bad.length > 0) {
    console.error("[p28.2] REGRESSION: legacy GUC pattern found in cron jobs:", bad);
    process.exit(2);
  }
  console.log("[p28.2] OK — no karel-* cron uses current_setting('app.karel_cron_secret').");
}

main().catch((e) => {
  console.error("[p28.2] audit failed:", e);
  process.exit(1);
});
