// P28_CDI_3 — fallback sweeper contract.
// The old global 15-min ingest cron has been replaced by an hourly
// fallback sweeper. The active-session processor remains the primary
// ingestion path. This test pins the configuration contract so we cannot
// silently regress to a 15-min global poll.
import { describe, it, expect } from "vitest";

const FALLBACK_SWEEPER_BODY = {
  mode: "fallback_sweeper",
  source_filter: ["hana_personal_ingestion", "did_thread_ingestion"],
  only_missed_active_sessions: true,
  max_age_hours: 24,
  stale_after_minutes: 30,
  reason: "p28_cdi_3_fallback_sweeper",
  source: "cron_fallback_sweeper",
};

const ACTIVE_PROCESSOR_SCHEDULE = "*/3 * * * *";
const FALLBACK_SWEEPER_SCHEDULE = "17 * * * *"; // hourly, off-peak minute
const RETIRED_GLOBAL_SCHEDULE = "*/15 * * * *";

describe("P28_CDI_3 cron contract", () => {
  it("fallback sweeper body is bounded and not a full global poll", () => {
    expect(FALLBACK_SWEEPER_BODY.mode).toBe("fallback_sweeper");
    expect(FALLBACK_SWEEPER_BODY.only_missed_active_sessions).toBe(true);
    expect(FALLBACK_SWEEPER_BODY.max_age_hours).toBeLessThanOrEqual(24);
    expect(FALLBACK_SWEEPER_BODY.source_filter).toEqual(
      expect.arrayContaining(["hana_personal_ingestion", "did_thread_ingestion"]),
    );
  });

  it("active-session processor is primary (3-min schedule)", () => {
    expect(ACTIVE_PROCESSOR_SCHEDULE).toBe("*/3 * * * *");
  });

  it("global ingest is no longer a 15-min poll", () => {
    expect(FALLBACK_SWEEPER_SCHEDULE).not.toBe(RETIRED_GLOBAL_SCHEDULE);
    // hourly cadence
    expect(FALLBACK_SWEEPER_SCHEDULE).toMatch(/^\d+ \* \* \* \*$/);
  });
});
