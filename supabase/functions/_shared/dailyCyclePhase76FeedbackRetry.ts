/**
 * P29B.3-H3: phase76_feedback_retry helper.
 *
 * Pure retry/state-repair logic for did_pending_emails. This helper is
 * INTENTIONALLY restricted:
 *   - MUST NOT call any AI gateway (AI generation is H4 territory).
 *   - MUST NOT send any email (real sending lives in H2 helper / queue).
 *   - MUST NOT enqueue or perform any Drive write.
 *
 * It reports retry candidates and, in production (non dry-run) mode, only
 * performs DB state repairs: marking rows that have exhausted retry_count
 * but are still flagged "pending" as "failed".
 */

export interface Phase76FeedbackRetryInput {
  dry_run?: boolean;
  source?: string;
  max_items?: number;
}

export interface Phase76FeedbackRetryParams {
  sb: any;
  cycleId: string;
  userId: string;
  input?: Phase76FeedbackRetryInput;
  setHeartbeat?: () => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Phase76FeedbackRetryResult {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  candidates_count: number;
  would_retry_count: number;
  retried_count: number;
  skipped_count: number;
  deduped_count: number;
  state_updates_count: number;
  controlled_skips: string[];
  errors: string[];
  source?: string;
}

const DEFAULT_MAX_ITEMS = 25;
const HARD_MAX_ITEMS = 100;

export async function runPhase76FeedbackRetry(
  params: Phase76FeedbackRetryParams,
): Promise<Phase76FeedbackRetryResult> {
  const started = Date.now();
  const input = params.input ?? {};
  const dry_run = input.dry_run !== false; // default TRUE
  const max_items = Math.min(
    Math.max(Number(input.max_items ?? DEFAULT_MAX_ITEMS), 1),
    HARD_MAX_ITEMS,
  );
  const errors: string[] = [];
  const controlled_skips: string[] = [];

  const result: Phase76FeedbackRetryResult = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    candidates_count: 0,
    would_retry_count: 0,
    retried_count: 0,
    skipped_count: 0,
    deduped_count: 0,
    state_updates_count: 0,
    controlled_skips,
    errors,
    source: input.source,
  };

  try {
    await params.setHeartbeat?.();

    // 1) Read pending retry candidates from did_pending_emails.
    const nowIso = new Date().toISOString();
    const { data: pending, error: readErr } = await params.sb
      .from("did_pending_emails")
      .select("id,status,retry_count,max_retries,next_retry_at,email_type")
      .eq("status", "pending")
      .lte("next_retry_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(max_items);

    if (readErr) {
      const msg = String(readErr.message ?? readErr);
      if (/relation .* does not exist|missing/i.test(msg)) {
        controlled_skips.push("missing_required_table");
        result.outcome = "controlled_skipped";
        result.duration_ms = Date.now() - started;
        return result;
      }
      errors.push(`read_pending_emails: ${msg}`);
    }

    const rows = (pending ?? []) as Array<{
      id: string;
      status: string;
      retry_count: number | null;
      max_retries: number | null;
      next_retry_at: string | null;
      email_type: string | null;
    }>;

    result.candidates_count = rows.length;

    if (rows.length === 0) {
      controlled_skips.push("no_feedback_retry_candidates");
      result.outcome = "controlled_skipped";
      result.duration_ms = Date.now() - started;
      return result;
    }

    // Dedupe by id (defensive — should already be unique).
    const seen = new Set<string>();
    const unique = rows.filter(r => {
      if (seen.has(r.id)) { result.deduped_count++; return false; }
      seen.add(r.id); return true;
    });

    for (const row of unique) {
      const rc = row.retry_count ?? 0;
      const max = row.max_retries ?? 3;
      if (rc >= max) {
        // Stuck row: pending but already exhausted retries → state repair to "failed".
        if (dry_run) {
          result.skipped_count++;
        } else {
          await params.setHeartbeat?.();
          const { error: upErr } = await params.sb
            .from("did_pending_emails")
            .update({ status: "failed", error_message: "p29b3_h3_state_repair_exhausted" })
            .eq("id", row.id);
          if (upErr) {
            errors.push(`state_repair_${row.id}: ${String(upErr.message ?? upErr)}`);
          } else {
            result.state_updates_count++;
          }
        }
      } else {
        // Eligible for retry. H3 does NOT actually send — that's owned by the
        // existing email queue / H2 escalation helper. We only count it.
        result.would_retry_count++;
        if (dry_run) {
          controlled_skips.push("dry_run_no_state_change");
        }
        // retried_count stays 0 in H3 — no send happens here, ever.
      }
    }

    if (dry_run && result.state_updates_count === 0 && result.would_retry_count > 0) {
      // Marker for clarity in result.
      if (!controlled_skips.includes("dry_run_no_state_change")) {
        controlled_skips.push("dry_run_no_state_change");
      }
    }

    result.outcome = "completed";
    result.duration_ms = Date.now() - started;
    return result;
  } catch (e: any) {
    errors.push(e?.message ?? String(e));
    result.outcome = "completed";
    result.duration_ms = Date.now() - started;
    return result;
  }
}
