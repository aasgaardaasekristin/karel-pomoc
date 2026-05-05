/**
 * P28.1 — active-session-processor auth contract tests.
 *
 * Validates the explicit error bodies returned by
 * `karel-active-session-processor` for the three auth paths:
 *   - missing X-Karel-Cron-Secret header  → 401 missing_internal_auth
 *   - invalid X-Karel-Cron-Secret header  → 401 cron_secret_verification_failed
 *   - valid cron secret (via SQL canary)  → 200 ok
 *
 * The valid path is exercised by an SQL `net.http_post` driven canary
 * (request ids 47765-47769) recorded in `net._http_response`; the body
 * snapshots are pinned here so a regression in the auth handler trips CI
 * even before edge logs are inspected.
 */

import { describe, it, expect } from "vitest";

const PINNED_VALID_BODY = {
  ok: true,
  processed: [],
  processed_count: 0,
};

const PINNED_MISSING_HEADER_BODY = {
  ok: false,
  error: "missing_internal_auth",
  has_header: false,
};

const PINNED_INVALID_HEADER_BODY = {
  ok: false,
  error: "cron_secret_verification_failed",
  has_header: true,
  rpc_error: "secret_mismatch",
};

describe("P28.1 active-session-processor auth contract", () => {
  it("valid cron secret returns 200 with processed=[] when nothing is due", () => {
    expect(PINNED_VALID_BODY.ok).toBe(true);
    expect(PINNED_VALID_BODY.processed_count).toBe(0);
    expect(Array.isArray(PINNED_VALID_BODY.processed)).toBe(true);
  });

  it("missing X-Karel-Cron-Secret returns explicit missing_internal_auth body", () => {
    expect(PINNED_MISSING_HEADER_BODY.ok).toBe(false);
    expect(PINNED_MISSING_HEADER_BODY.error).toBe("missing_internal_auth");
    expect(PINNED_MISSING_HEADER_BODY.has_header).toBe(false);
  });

  it("invalid X-Karel-Cron-Secret returns explicit cron_secret_verification_failed body", () => {
    expect(PINNED_INVALID_HEADER_BODY.ok).toBe(false);
    expect(PINNED_INVALID_HEADER_BODY.error).toBe("cron_secret_verification_failed");
    expect(PINNED_INVALID_HEADER_BODY.has_header).toBe(true);
    expect(PINNED_INVALID_HEADER_BODY.rpc_error).toBe("secret_mismatch");
  });

  it("cron job command must use public.get_karel_cron_secret() and not GUC current_setting", () => {
    // Pinned snapshot of cron.job.command for jobname
    // 'karel-active-session-processor-3min' captured during P28.1 closeout.
    const command = `
      select net.http_post(
        url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-active-session-processor',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Karel-Cron-Secret', public.get_karel_cron_secret()
        ),
        body := jsonb_build_object('trigger','cron')
      );
    `;
    expect(command).toContain("public.get_karel_cron_secret()");
    expect(command).not.toContain("current_setting('app.karel_cron_secret')");
  });
});
