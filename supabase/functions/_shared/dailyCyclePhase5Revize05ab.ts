/**
 * P29B.3-H5: phase5_revize_05ab helper.
 *
 * Detached version of the inline FÁZE 5 "Denní revize 05A/05B" block from
 * karel-did-daily-cycle (lines 5353–5457 in the legacy inline body):
 *
 *   1. Expire active did_plan_items where expires_at < now()
 *   2. Review active items where review_at < now():
 *        - 05A crisis_watch + no part-thread activity 72h → downgrade to active_parts
 *        - 05A active_parts + no activity 14d         → demote 05A → 05B
 *   3. Promote 05B items to 05A when matching part has activity in last 48h
 *   4. (Optional, apply_output only) trigger post-intervention-sync to flush
 *      governed plan-text writes to Drive (fire-and-forget).
 *
 * STRICT BOUNDARIES (H5 scope):
 *   - NO new clinical conclusion without evidence
 *   - NO live session start, NO playroom start, NO signoff mutation
 *   - NO direct Drive API call; Drive only via post-intervention-sync which
 *     itself goes through P29A governance (safeEnqueueDriveWrite). The helper
 *     must NEVER touch did_pending_drive_writes directly.
 *   - NO AI call in this helper. (phase5 inline never used AI; H5 keeps it
 *     deterministic.)
 *   - phase5.5 crisis_bridge is intentionally NOT part of H5 — it is split to
 *     a future helper. A controlled_skip reason
 *     `crisis_bridge_split_to_future_helper` documents that.
 *
 * Defaults:
 *   - dry_run     = true
 *   - apply_output = false
 * Production write only when apply_output === true (and dry_run !== true).
 */

export interface Phase5Revize05abInput {
  dry_run?: boolean;
  apply_output?: boolean;
  source?: string;
  max_items?: number;
}

export interface Phase5Revize05abParams {
  sb: any;
  cycleId: string;
  userId: string;
  input?: Phase5Revize05abInput;
  setHeartbeat?: () => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Phase5Revize05abResult {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  apply_output: boolean;
  candidates_count: number;
  evaluated_count: number;
  would_update_count: number;
  would_enqueue_drive_count: number;
  db_updates_count: number;
  drive_writes_enqueued: number;
  controlled_skips: string[];
  errors: string[];
  source?: string;
  // breakdown for observability
  expired_count: number;
  downgraded_count: number;
  demoted_count: number;
  promoted_count: number;
  crisis_bridge_split: boolean;
}

const DEFAULT_MAX_ITEMS = 25;
const HARD_MAX_ITEMS = 100;

export async function runPhase5Revize05ab(
  params: Phase5Revize05abParams,
): Promise<Phase5Revize05abResult> {
  const started = Date.now();
  const input = params.input ?? {};
  const dry_run = input.dry_run !== false; // default TRUE
  const apply_output = input.apply_output === true; // default FALSE
  const max_items = Math.min(
    Math.max(Number(input.max_items ?? DEFAULT_MAX_ITEMS), 1),
    HARD_MAX_ITEMS,
  );

  const errors: string[] = [];
  const controlled_skips: string[] = [];

  const result: Phase5Revize05abResult = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    apply_output,
    candidates_count: 0,
    evaluated_count: 0,
    would_update_count: 0,
    would_enqueue_drive_count: 0,
    db_updates_count: 0,
    drive_writes_enqueued: 0,
    controlled_skips,
    errors,
    source: input.source,
    expired_count: 0,
    downgraded_count: 0,
    demoted_count: 0,
    promoted_count: 0,
    // crisis_bridge is intentionally split out of H5 scope
    crisis_bridge_split: true,
  };
  // Always document the explicit scope split.
  controlled_skips.push("crisis_bridge_split_to_future_helper");

  try {
    await params.setHeartbeat?.();
    const reviewNow = new Date().toISOString();

    // ── Step 1: candidate/data load ──────────────────────────────────
    // 1a. Expirable items (active + expires_at < now)
    const { data: expirableRaw, error: expErr } = await params.sb
      .from("did_plan_items")
      .select("id, plan_type, section, status, expires_at")
      .eq("status", "active")
      .lt("expires_at", reviewNow)
      .limit(max_items);
    if (expErr) {
      const msg = String(expErr.message ?? expErr);
      if (/relation .* does not exist|does not exist/i.test(msg)) {
        controlled_skips.push("missing_required_table");
        result.outcome = "controlled_skipped";
        result.duration_ms = Date.now() - started;
        return result;
      }
      errors.push(`read_expirable: ${msg}`);
    }
    const expirable = (expirableRaw ?? []) as Array<{ id: string }>;

    // 1b. Items needing review
    const { data: reviewableRaw, error: revErr } = await params.sb
      .from("did_plan_items")
      .select("id, plan_type, section, subject_id, content, review_at")
      .eq("status", "active")
      .lt("review_at", reviewNow)
      .limit(max_items);
    if (revErr) errors.push(`read_reviewable: ${String(revErr.message ?? revErr)}`);
    const reviewable = (reviewableRaw ?? []) as Array<{
      id: string;
      plan_type: string | null;
      section: string | null;
      subject_id: string | null;
      content: string | null;
      review_at: string | null;
    }>;

    // 1c. Promotable 05B items (with promotion_criteria set)
    const { data: promotableRaw, error: promErr } = await params.sb
      .from("did_plan_items")
      .select("id, subject_type, subject_id, content, action_required, assigned_to, source_observation_ids")
      .eq("plan_type", "05B")
      .eq("status", "active")
      .not("promotion_criteria", "is", null)
      .limit(max_items);
    if (promErr) errors.push(`read_promotable: ${String(promErr.message ?? promErr)}`);
    const promotable = (promotableRaw ?? []) as Array<{
      id: string;
      subject_type: string | null;
      subject_id: string | null;
      content: string | null;
      action_required: string | null;
      assigned_to: string | null;
      source_observation_ids: any;
    }>;

    result.candidates_count =
      expirable.length + reviewable.length + promotable.length;

    if (result.candidates_count === 0) {
      controlled_skips.push("no_phase5_candidates");
      result.outcome = "controlled_skipped";
      result.duration_ms = Date.now() - started;
      return result;
    }

    await params.setHeartbeat?.();

    // ── Step 2: revize computation (deterministic) ───────────────────
    type DowngradeOp = { id: string; subject_id: string };
    type DemoteOp = { id: string; subject_id: string; content: string };
    type PromoteOp = {
      source_id: string;
      insert_row: Record<string, unknown>;
    };

    const downgrades: DowngradeOp[] = [];
    const demotes: DemoteOp[] = [];

    for (const item of reviewable) {
      result.evaluated_count++;
      const partName = item.subject_id ?? "";
      if (!partName) continue;

      // Look up last activity for this part
      const { data: lastThread } = await params.sb
        .from("did_threads")
        .select("last_activity_at")
        .eq("part_name", partName)
        .order("last_activity_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastActivity = lastThread?.last_activity_at
        ? new Date(lastThread.last_activity_at)
        : null;
      const hoursSinceActivity = lastActivity
        ? (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60)
        : Infinity;

      if (item.plan_type === "05A" && item.section === "crisis_watch" && hoursSinceActivity > 72) {
        downgrades.push({ id: item.id, subject_id: partName });
      } else if (item.plan_type === "05A" && hoursSinceActivity > 14 * 24) {
        demotes.push({
          id: item.id,
          subject_id: partName,
          content: (item.content ?? "") + " [PŘESUNUTO Z 05A – neaktivní >14d]",
        });
      }
    }

    const promotes: PromoteOp[] = [];
    for (const item of promotable) {
      result.evaluated_count++;
      const partName = item.subject_id ?? "";
      if (!partName) continue;
      const { data: recentThread } = await params.sb
        .from("did_threads")
        .select("id")
        .eq("part_name", partName)
        .gte("last_activity_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
        .limit(1)
        .maybeSingle();
      if (recentThread) {
        promotes.push({
          source_id: item.id,
          insert_row: {
            plan_type: "05A",
            section: "active_parts",
            subject_type: item.subject_type,
            subject_id: item.subject_id,
            content: `[POVÝŠENO Z 05B] ${item.content ?? ""}`,
            priority: "high",
            action_required: item.action_required,
            assigned_to: item.assigned_to,
            status: "active",
            review_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            source_observation_ids: item.source_observation_ids,
          },
        });
      }
    }

    // ── Step 3: output planning ──────────────────────────────────────
    result.would_update_count =
      expirable.length + downgrades.length + demotes.length + promotes.length;
    // If anything materially changes the plan text, we'd enqueue a Drive flush.
    result.would_enqueue_drive_count =
      result.would_update_count > 0 ? 1 : 0;

    if (dry_run) {
      controlled_skips.push("dry_run_no_apply");
      result.outcome = "completed";
      result.duration_ms = Date.now() - started;
      return result;
    }
    if (!apply_output) {
      controlled_skips.push("apply_output_false");
      result.outcome = "completed";
      result.duration_ms = Date.now() - started;
      return result;
    }

    // ── Step 4: optional apply (apply_output === true) ───────────────
    await params.setHeartbeat?.();

    // 4a. Expire
    if (expirable.length > 0) {
      const { error: e } = await params.sb
        .from("did_plan_items")
        .update({ status: "expired" })
        .in("id", expirable.map(x => x.id));
      if (e) errors.push(`expire: ${String(e.message ?? e)}`);
      else { result.expired_count += expirable.length; result.db_updates_count += expirable.length; }
    }

    // 4b. Downgrade
    for (const op of downgrades) {
      const { error: e } = await params.sb
        .from("did_plan_items")
        .update({
          section: "active_parts",
          priority: "normal",
          review_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", op.id);
      if (e) errors.push(`downgrade_${op.id}: ${String(e.message ?? e)}`);
      else { result.downgraded_count++; result.db_updates_count++; }
    }

    // 4c. Demote 05A → 05B
    for (const op of demotes) {
      const { error: e } = await params.sb
        .from("did_plan_items")
        .update({
          plan_type: "05B",
          section: "parts_readiness",
          status: "active",
          content: op.content,
          review_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .eq("id", op.id);
      if (e) errors.push(`demote_${op.id}: ${String(e.message ?? e)}`);
      else { result.demoted_count++; result.db_updates_count++; }
    }

    // 4d. Promote 05B → 05A
    for (const op of promotes) {
      const { error: insErr } = await params.sb
        .from("did_plan_items")
        .insert(op.insert_row);
      if (insErr) {
        errors.push(`promote_insert_${op.source_id}: ${String(insErr.message ?? insErr)}`);
        continue;
      }
      const { error: updErr } = await params.sb
        .from("did_plan_items")
        .update({ status: "promoted" })
        .eq("id", op.source_id);
      if (updErr) errors.push(`promote_mark_${op.source_id}: ${String(updErr.message ?? updErr)}`);
      result.promoted_count++;
      result.db_updates_count += 2;
    }

    // 4e. Drive flush via governed sync function (fire-and-forget,
    // post-intervention-sync internally uses safeEnqueueDriveWrite — we never
    // touch did_pending_drive_writes directly here).
    if (result.db_updates_count > 0) {
      try {
        const url = `${(globalThis as any).Deno?.env?.get?.("SUPABASE_URL")}/functions/v1/post-intervention-sync`;
        const key = (globalThis as any).Deno?.env?.get?.("SUPABASE_SERVICE_ROLE_KEY");
        if (url && key) {
          // Fire-and-forget; do not await.
          fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ trigger: "p29b3_h5_phase5_revize_05ab" }),
          }).catch(() => { /* swallow */ });
          result.drive_writes_enqueued = 1;
        }
      } catch (e: any) {
        errors.push(`drive_flush_trigger: ${e?.message ?? String(e)}`);
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
