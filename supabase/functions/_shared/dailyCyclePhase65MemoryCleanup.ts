/**
 * P29B.3-H6: phase65_memory_cleanup helper.
 *
 * Detached version of the inline FÁZE 6.5 + 6.6 blocks from
 * karel-did-daily-cycle (memory cleanup + ai_error_log cleanup).
 *
 * Original inline behavior (now behind P29B_DISABLE_INLINE_PHASE_5_7):
 *   1. DELETE session_memory WHERE session_date < now()-90d AND manually_edited=false
 *   2. UPDATE karel_promises SET status='cancelled' WHERE status='active'
 *      AND created_at < now()-30d
 *   3. DELETE ai_error_log WHERE created_at < now()-30d
 *
 * STRICT BOUNDARIES (H6 scope):
 *   - NO AI call
 *   - NO email send
 *   - NO Drive write (no did_pending_drive_writes, no safeEnqueueDriveWrite)
 *   - NO live session / playroom / signoff mutation
 *   - NO destructive delete on sensitive clinical or audit tables
 *     (did_update_cycles, did_event_ingestion_log, did_daily_briefings,
 *      did_daily_cycle_phase_jobs, did_daily_cycle_phase_payloads,
 *      did_pending_drive_writes, card_update_queue, hana_personal_memory,
 *      did_part_registry, did_part_profiles, did_daily_session_plans,
 *      did_team_deliberations, did_observations, did_implications)
 *
 * Cache-only delete is allowed for explicitly safe tables:
 *   - ai_error_log (pure debug log)
 *   - session_memory rows that are auto-generated, NOT manually_edited,
 *     and older than max_age_days (matches legacy inline behavior)
 *
 * For karel_promises we only do a status update (active → cancelled)
 * for stale promises — no delete.
 *
 * Defaults:
 *   - dry_run     = true
 *   - apply_output = false
 */

export interface Phase65MemoryCleanupInput {
  dry_run?: boolean;
  apply_output?: boolean;
  source?: string;
  max_items?: number;
  max_age_days?: number;
}

export interface Phase65MemoryCleanupParams {
  sb: any;
  cycleId: string;
  userId: string;
  input?: Phase65MemoryCleanupInput;
  setHeartbeat?: () => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Phase65MemoryCleanupResult {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  apply_output: boolean;
  candidates_count: number;
  evaluated_count: number;
  would_archive_count: number;
  would_delete_cache_count: number;
  archived_count: number;
  deleted_cache_count: number;
  blocked_sensitive_count: number;
  skipped_count: number;
  controlled_skips: string[];
  errors: string[];
  tables_touched: string[];
  source?: string;
}

const DEFAULT_MAX_ITEMS = 100;
const HARD_MAX_ITEMS = 500;
const DEFAULT_MAX_AGE_DAYS = 30;
const HARD_MIN_MAX_AGE_DAYS = 7;

// Tables for which destructive .delete() is FORBIDDEN by H6.
const SENSITIVE_TABLES = [
  "did_update_cycles",
  "did_event_ingestion_log",
  "did_daily_briefings",
  "did_daily_cycle_phase_jobs",
  "did_daily_cycle_phase_payloads",
  "did_pending_drive_writes",
  "card_update_queue",
  "hana_personal_memory",
  "did_part_registry",
  "did_part_profiles",
  "did_daily_session_plans",
  "did_team_deliberations",
  "did_observations",
  "did_implications",
] as const;

export async function runPhase65MemoryCleanup(
  params: Phase65MemoryCleanupParams,
): Promise<Phase65MemoryCleanupResult> {
  const started = Date.now();
  const input = params.input ?? {};
  const dry_run = input.dry_run !== false; // default TRUE
  const apply_output = input.apply_output === true; // default FALSE
  const max_items = Math.min(
    Math.max(Number(input.max_items ?? DEFAULT_MAX_ITEMS), 1),
    HARD_MAX_ITEMS,
  );
  const max_age_days = Math.max(
    Number(input.max_age_days ?? DEFAULT_MAX_AGE_DAYS),
    HARD_MIN_MAX_AGE_DAYS,
  );
  const log = params.log ?? (() => {});
  const sb = params.sb;

  const result: Phase65MemoryCleanupResult = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    apply_output,
    candidates_count: 0,
    evaluated_count: 0,
    would_archive_count: 0,
    would_delete_cache_count: 0,
    archived_count: 0,
    deleted_cache_count: 0,
    blocked_sensitive_count: 0,
    skipped_count: 0,
    controlled_skips: [],
    errors: [],
    tables_touched: [],
    source: input.source,
  };

  // Sentinel: SENSITIVE_TABLES exists at runtime so the constant cannot
  // be tree-shaken. Touching it here also makes the boundary explicit.
  result.blocked_sensitive_count = 0; // we never delete from SENSITIVE_TABLES
  void SENSITIVE_TABLES;

  const cutoffMemory = new Date(Date.now() - 90 * 86400000).toISOString();
  const cutoffPromises = new Date(Date.now() - 30 * 86400000).toISOString();
  const cutoffErrLog = new Date(Date.now() - max_age_days * 86400000).toISOString();

  try {
    await params.setHeartbeat?.();

    // ── 1. CANDIDATE DISCOVERY (cheap counts, bounded) ─────────────────
    let memCandidates = 0;
    let promiseCandidates = 0;
    let errLogCandidates = 0;

    try {
      const { count } = await sb.from("session_memory")
        .select("id", { count: "exact", head: true })
        .lt("session_date", cutoffMemory)
        .eq("manually_edited", false);
      memCandidates = count ?? 0;
    } catch (e: any) {
      result.errors.push(`session_memory_count_failed:${(e?.message ?? String(e)).slice(0, 120)}`);
      result.controlled_skips.push("missing_required_table");
    }

    try {
      const { count } = await sb.from("karel_promises")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .lt("created_at", cutoffPromises);
      promiseCandidates = count ?? 0;
    } catch (e: any) {
      result.errors.push(`karel_promises_count_failed:${(e?.message ?? String(e)).slice(0, 120)}`);
      result.controlled_skips.push("missing_required_table");
    }

    try {
      const { count } = await sb.from("ai_error_log")
        .select("id", { count: "exact", head: true })
        .lt("created_at", cutoffErrLog);
      errLogCandidates = count ?? 0;
    } catch (e: any) {
      result.errors.push(`ai_error_log_count_failed:${(e?.message ?? String(e)).slice(0, 120)}`);
      result.controlled_skips.push("missing_required_table");
    }

    result.candidates_count = memCandidates + promiseCandidates + errLogCandidates;
    result.evaluated_count = result.candidates_count;

    if (result.candidates_count === 0) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push("no_memory_cleanup_candidates");
      result.duration_ms = Date.now() - started;
      log("[phase65] no candidates", { cutoffMemory, cutoffPromises, cutoffErrLog });
      return result;
    }

    // ── 2. SAFETY CLASSIFICATION ───────────────────────────────────────
    // session_memory + ai_error_log → safe_to_delete_cache_only (with bounds)
    // karel_promises stale active   → safe_to_archive (status update)
    const wouldDeleteSessionMemory = Math.min(memCandidates, max_items);
    const wouldDeleteErrLog = Math.min(errLogCandidates, max_items);
    const wouldArchivePromises = Math.min(promiseCandidates, max_items);

    result.would_delete_cache_count = wouldDeleteSessionMemory + wouldDeleteErrLog;
    result.would_archive_count = wouldArchivePromises;

    await params.setHeartbeat?.();

    // ── 3. DRY-RUN EXIT ────────────────────────────────────────────────
    if (dry_run || !apply_output) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push(dry_run ? "dry_run_no_apply" : "apply_output_false");
      result.duration_ms = Date.now() - started;
      log("[phase65] dry-run plan", {
        would_delete_cache_count: result.would_delete_cache_count,
        would_archive_count: result.would_archive_count,
      });
      return result;
    }

    // ── 4. APPLY (cache-only deletes + archive status updates) ─────────
    if (wouldArchivePromises > 0) {
      try {
        const { error } = await sb.from("karel_promises")
          .update({ status: "cancelled" })
          .eq("status", "active")
          .lt("created_at", cutoffPromises);
        if (error) {
          result.errors.push(`promises_archive_failed:${error.message.slice(0, 120)}`);
        } else {
          result.archived_count += wouldArchivePromises;
          result.tables_touched.push("karel_promises");
        }
      } catch (e: any) {
        result.errors.push(`promises_archive_exc:${(e?.message ?? String(e)).slice(0, 120)}`);
      }
    }

    await params.setHeartbeat?.();

    if (wouldDeleteSessionMemory > 0) {
      try {
        // cache-only: only auto-generated, non-manually-edited, >90d old
        const { error, count } = await sb.from("session_memory")
          .delete({ count: "exact" })
          .lt("session_date", cutoffMemory)
          .eq("manually_edited", false);
        if (error) {
          result.errors.push(`session_memory_delete_failed:${error.message.slice(0, 120)}`);
        } else {
          result.deleted_cache_count += count ?? wouldDeleteSessionMemory;
          result.tables_touched.push("session_memory");
        }
      } catch (e: any) {
        result.errors.push(`session_memory_delete_exc:${(e?.message ?? String(e)).slice(0, 120)}`);
      }
    }

    await params.setHeartbeat?.();

    if (wouldDeleteErrLog > 0) {
      try {
        const { error, count } = await sb.from("ai_error_log")
          .delete({ count: "exact" })
          .lt("created_at", cutoffErrLog);
        if (error) {
          result.errors.push(`ai_error_log_delete_failed:${error.message.slice(0, 120)}`);
        } else {
          result.deleted_cache_count += count ?? wouldDeleteErrLog;
          result.tables_touched.push("ai_error_log");
        }
      } catch (e: any) {
        result.errors.push(`ai_error_log_delete_exc:${(e?.message ?? String(e)).slice(0, 120)}`);
      }
    }

    result.outcome = "completed";
    result.duration_ms = Date.now() - started;
    return result;
  } catch (e: any) {
    result.errors.push(`fatal:${(e?.message ?? String(e)).slice(0, 200)}`);
    result.outcome = "controlled_skipped";
    result.controlled_skips.push("fatal_caught");
    result.duration_ms = Date.now() - started;
    return result;
  }
}
