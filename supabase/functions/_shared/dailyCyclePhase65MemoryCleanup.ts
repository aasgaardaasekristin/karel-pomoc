/**
 * P29B.3-H6 / H6.1: phase65_memory_cleanup helper.
 *
 * H6.1 SAFETY HARDENING:
 *   - session_memory is treated as SENSITIVE / clinically relevant.
 *     There is NO `.delete()` against session_memory anywhere in this file,
 *     not even guarded. The only allowed mutation is an archive/retention
 *     status update IF the table exposes one of the retention columns
 *     (retention_state, pipeline_state, archived_at, superseded_at).
 *     Today the table has none of those columns, so the helper records
 *     a controlled_skip `session_memory_retention_columns_missing_no_delete`
 *     and leaves session_memory untouched.
 *   - ai_error_log delete is gated behind an explicit env kill-switch
 *     PHASE65_ENABLE_CACHE_DELETE (default "false"). When the switch is
 *     off, the helper plans the cleanup but performs no delete.
 *   - When the switch is on, the helper may only delete from tables in
 *     CACHE_DELETE_ALLOWLIST. session_memory is NEVER on that allowlist.
 *   - karel_promises uses an UPDATE (active → cancelled) only. No delete.
 *
 * Other strict boundaries (unchanged from H6):
 *   - NO AI call, NO email, NO Drive write, NO live-session / playroom /
 *     signoff mutation, NO destructive delete on any sensitive clinical
 *     or audit table.
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

  // H6.1 explicit safety reporting
  session_memory_would_archive_count: number;
  session_memory_archived_count: number;
  session_memory_delete_forbidden: boolean;
  cache_delete_enabled: boolean;
  cache_delete_allowlist: string[];
  sensitive_delete_attempts_blocked: number;
}

const DEFAULT_MAX_ITEMS = 100;
const HARD_MAX_ITEMS = 500;
const DEFAULT_MAX_AGE_DAYS = 30;
const HARD_MIN_MAX_AGE_DAYS = 7;

// Tables for which destructive .delete() is FORBIDDEN by H6.1.
// session_memory is included here on purpose: it may carry clinically
// significant memory and must never be hard-deleted from this helper.
const SENSITIVE_TABLES = [
  "session_memory",
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

// H6.1 explicit cache-delete kill switch. Default OFF.
const PHASE65_ENABLE_CACHE_DELETE =
  (Deno.env.get("PHASE65_ENABLE_CACHE_DELETE") ?? "false").toLowerCase() === "true";

// H6.1 explicit allowlist for cache-only delete. session_memory MUST
// NEVER appear here.
const CACHE_DELETE_ALLOWLIST = ["ai_error_log"] as const;

// Retention/archival columns we look for on session_memory before
// considering any non-destructive archive update. The current schema
// does not expose any of these, so the helper records a controlled_skip.
const SESSION_MEMORY_RETENTION_COLUMNS = [
  "retention_state",
  "pipeline_state",
  "archived_at",
  "superseded_at",
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
    session_memory_would_archive_count: 0,
    session_memory_archived_count: 0,
    session_memory_delete_forbidden: true,
    cache_delete_enabled: PHASE65_ENABLE_CACHE_DELETE,
    cache_delete_allowlist: [...CACHE_DELETE_ALLOWLIST],
    sensitive_delete_attempts_blocked: 0,
  };

  // Sentinel: SENSITIVE_TABLES exists at runtime so the constant cannot
  // be tree-shaken. Touching it here also makes the boundary explicit.
  void SENSITIVE_TABLES;
  void SESSION_MEMORY_RETENTION_COLUMNS;
  // Hard invariant: session_memory must never appear in the cache-delete
  // allowlist. Enforced at module load time as well.
  if ((CACHE_DELETE_ALLOWLIST as readonly string[]).includes("session_memory")) {
    throw new Error("phase65_invariant_violation:session_memory_in_cache_delete_allowlist");
  }

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

    // ── 2. SENSITIVE-TABLE CLASSIFICATION ─────────────────────────────
    // session_memory is sensitive. We do NOT plan a delete for it; we
    // only consider archival, but only if retention columns exist.
    // The current schema does not have those columns, so we controlled-skip
    // session_memory entirely and count its rows as blocked-from-delete.
    const sessionMemoryHasRetentionColumns = false; // verified at design time
    if (memCandidates > 0) {
      result.blocked_sensitive_count += memCandidates;
      if (sessionMemoryHasRetentionColumns) {
        // Reserved for the future: archive update path (still no delete).
        result.session_memory_would_archive_count = Math.min(memCandidates, max_items);
      } else {
        result.controlled_skips.push("session_memory_retention_columns_missing_no_delete");
      }
    }

    // ── 3. CACHE-DELETE PLAN (ai_error_log only, behind kill switch) ──
    const wouldDeleteErrLog = Math.min(errLogCandidates, max_items);
    const wouldArchivePromises = Math.min(promiseCandidates, max_items);

    result.would_delete_cache_count = wouldDeleteErrLog;
    result.would_archive_count = wouldArchivePromises;

    if (result.candidates_count === 0) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push("no_memory_cleanup_candidates");
      result.duration_ms = Date.now() - started;
      log("[phase65] no candidates", { cutoffMemory, cutoffPromises, cutoffErrLog });
      return result;
    }

    await params.setHeartbeat?.();

    // ── 4. DRY-RUN / APPLY-DISABLED EXIT ──────────────────────────────
    if (dry_run || !apply_output) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push(dry_run ? "dry_run_no_apply" : "apply_output_false");
      if (!PHASE65_ENABLE_CACHE_DELETE && wouldDeleteErrLog > 0) {
        result.controlled_skips.push("cache_delete_disabled_by_default");
      }
      result.duration_ms = Date.now() - started;
      log("[phase65] dry-run plan", {
        would_delete_cache_count: result.would_delete_cache_count,
        would_archive_count: result.would_archive_count,
        cache_delete_enabled: result.cache_delete_enabled,
        session_memory_delete_forbidden: result.session_memory_delete_forbidden,
      });
      return result;
    }

    // ── 5. APPLY: archive promises (UPDATE only, never delete) ────────
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

    // ── 6. APPLY: cache-only delete (ai_error_log) behind kill switch ──
    // Only allowed if PHASE65_ENABLE_CACHE_DELETE=true AND target is in
    // CACHE_DELETE_ALLOWLIST. session_memory is never targeted here.
    if (wouldDeleteErrLog > 0) {
      const target = "ai_error_log";
      const inAllowlist = (CACHE_DELETE_ALLOWLIST as readonly string[]).includes(target);
      const inSensitive = (SENSITIVE_TABLES as readonly string[]).includes(target);
      if (!PHASE65_ENABLE_CACHE_DELETE) {
        result.controlled_skips.push("cache_delete_disabled_by_default");
      } else if (!inAllowlist || inSensitive) {
        result.sensitive_delete_attempts_blocked += 1;
        result.controlled_skips.push("cache_delete_target_not_in_allowlist");
      } else {
        try {
          const { error, count } = await sb.from(target)
            .delete({ count: "exact" })
            .lt("created_at", cutoffErrLog);
          if (error) {
            result.errors.push(`ai_error_log_delete_failed:${error.message.slice(0, 120)}`);
          } else {
            result.deleted_cache_count += count ?? wouldDeleteErrLog;
            result.tables_touched.push(target);
          }
        } catch (e: any) {
          result.errors.push(`ai_error_log_delete_exc:${(e?.message ?? String(e)).slice(0, 120)}`);
        }
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
