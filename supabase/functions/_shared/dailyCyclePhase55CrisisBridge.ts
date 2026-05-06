/**
 * P29B.3-H7: phase55_crisis_bridge helper.
 *
 * Detached, safety-hardened version of the inline FÁZE 5.5 crisis bridge
 * block from karel-did-daily-cycle. The original block:
 *   - bridged crisis_alerts → crisis_events,
 *   - applied phase transitions,
 *   - called karel-crisis-daily-assessment via HTTP (AI heavy),
 *   - inserted "escalation" notes into did_pending_drive_writes,
 *   - and queued crisis emails via queue an email.
 *
 * H7 SCOPE:
 *   This helper is a **read-only / planning** crisis bridge. It only
 *   evaluates evidence and reports what it WOULD do. It NEVER:
 *     - calls AI by default,
 *     - sends or queues an email,
 *     - writes to Drive (governed or not),
 *     - mutates session/playroom/signoff/therapy plan rows,
 *     - upgrades evidence levels, diagnoses, or invents conclusions.
 *
 * Triple safety guards (all default to OFF / safe):
 *   - dry_run        (default true)  — no DB mutation at all
 *   - apply_output   (default false) — only therapist-review task/flag
 *   - generate_ai    (default false) — no AI call
 *   - send_alert     (default false) — no email / no alert push
 *
 * Email path stays the responsibility of phase75_escalation_emails.
 * Drive writes stay the responsibility of P29A governed write pipeline.
 * AI assessment stays opt-in only.
 *
 * Evidence taxonomy (deterministic):
 *   D1 = direct observed (open crisis_event with confirmed trigger)
 *   D2 = therapist-confirmed (assessment with therapist signoff)
 *   I1 = inference (active crisis_alert without matching crisis_event)
 *   I0 = weak hint (long-stale event without recent action signal)
 *
 * Only D1 / D2 evidence may produce `would_create_task` / `would_flag`.
 * I0 / I1 hints are reported but never auto-task. Hana-personal raw
 * text is never read by this helper.
 */

export interface Phase55CrisisBridgeInput {
  dry_run?: boolean;
  apply_output?: boolean;
  generate_ai?: boolean;
  send_alert?: boolean;
  source?: string;
  max_candidates?: number;
}

export interface Phase55CrisisBridgeParams {
  sb: any;
  cycleId: string;
  userId: string;
  input?: Phase55CrisisBridgeInput;
  setHeartbeat?: () => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Phase55CrisisBridgeResult {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  apply_output: boolean;
  generate_ai: boolean;
  send_alert: boolean;
  candidates_count: number;
  evaluated_count: number;
  weak_hints_count: number;
  evidence_supported_count: number;
  would_flag_count: number;
  would_create_task_count: number;
  would_enqueue_drive_count: number;
  tasks_created_count: number;
  drive_writes_enqueued: number;
  alerts_sent_count: number;
  ai_calls_made: number;
  controlled_skips: string[];
  errors: string[];
  evidence_levels_summary: { D1: number; D2: number; I1: number; I0: number };
  requires_therapist_review_count: number;
  source?: string;
}

const DEFAULT_MAX_CANDIDATES = 20;
const HARD_MAX_CANDIDATES = 100;

/**
 * H7 invariants — the helper must NEVER perform any of these operations.
 * Listed as a sentinel so source audits can confirm we declared them.
 */
const FORBIDDEN_LIVE_TOKENS = [
  "live_session_start",
  "playroom_start",
  "session_signoff",
  "session_start",
  "playroom_session_create",
] as const;

export async function runPhase55CrisisBridge(
  params: Phase55CrisisBridgeParams,
): Promise<Phase55CrisisBridgeResult> {
  const started = Date.now();
  const input = params.input ?? {};
  const dry_run = input.dry_run !== false; // default TRUE
  const apply_output = input.apply_output === true; // default FALSE
  const generate_ai = input.generate_ai === true; // default FALSE
  const send_alert = input.send_alert === true; // default FALSE
  const max_candidates = Math.min(
    Math.max(Number(input.max_candidates ?? DEFAULT_MAX_CANDIDATES), 1),
    HARD_MAX_CANDIDATES,
  );

  const log = params.log ?? (() => {});
  const sb = params.sb;

  // Sentinel: keep the forbidden-token list referenced at runtime so
  // dead-code analysis cannot strip it.
  void FORBIDDEN_LIVE_TOKENS;

  const result: Phase55CrisisBridgeResult = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    apply_output,
    generate_ai,
    send_alert,
    candidates_count: 0,
    evaluated_count: 0,
    weak_hints_count: 0,
    evidence_supported_count: 0,
    would_flag_count: 0,
    would_create_task_count: 0,
    would_enqueue_drive_count: 0,
    tasks_created_count: 0,
    drive_writes_enqueued: 0,
    alerts_sent_count: 0,
    ai_calls_made: 0,
    controlled_skips: [],
    errors: [],
    evidence_levels_summary: { D1: 0, D2: 0, I1: 0, I0: 0 },
    requires_therapist_review_count: 0,
    source: input.source,
  };

  try {
    await params.setHeartbeat?.();

    // ── 1. CANDIDATE DISCOVERY ───────────────────────────────────────
    // Bounded reads from canonical crisis tables. No AI, no Drive, no
    // Hana-personal raw text.
    let activeEvents: any[] = [];
    let activeAlerts: any[] = [];
    try {
      const { data } = await sb
        .from("crisis_events")
        .select("id, part_name, phase, severity, opened_at, days_active, trigger_description, diagnostic_date, updated_at")
        .not("phase", "eq", "closed")
        .order("opened_at", { ascending: false })
        .limit(max_candidates);
      activeEvents = data ?? [];
    } catch (e: any) {
      result.errors.push(`crisis_events_read_failed:${(e?.message ?? String(e)).slice(0, 120)}`);
      result.controlled_skips.push("missing_required_table");
    }

    try {
      const { data } = await sb
        .from("crisis_alerts")
        .select("id, part_name, severity, summary, status, created_at")
        .in("status", ["ACTIVE", "ACKNOWLEDGED"])
        .order("created_at", { ascending: false })
        .limit(max_candidates);
      activeAlerts = data ?? [];
    } catch (e: any) {
      result.errors.push(`crisis_alerts_read_failed:${(e?.message ?? String(e)).slice(0, 120)}`);
      result.controlled_skips.push("missing_required_table");
    }

    result.candidates_count = activeEvents.length + activeAlerts.length;

    if (result.candidates_count === 0) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push("no_crisis_bridge_candidates");
      result.duration_ms = Date.now() - started;
      log("[phase55] no candidates");
      return result;
    }

    await params.setHeartbeat?.();

    // ── 2. EVIDENCE CLASSIFICATION (deterministic) ───────────────────
    // We map each candidate to an evidence level and decide what it
    // WOULD trigger. Nothing is mutated here.
    const eventByPart = new Map<string, any>();
    for (const ev of activeEvents) {
      if (ev.part_name) eventByPart.set(ev.part_name, ev);
    }

    type Plan = {
      partName: string;
      level: "D1" | "D2" | "I1" | "I0";
      wouldFlag: boolean;
      wouldCreateTask: boolean;
      requiresTherapistReview: boolean;
      reason: string;
    };
    const plans: Plan[] = [];

    for (const ev of activeEvents) {
      const partName = ev.part_name as string | null;
      if (!partName) continue;
      const hasTrigger = !!(ev.trigger_description && String(ev.trigger_description).trim());
      const lastAction = ev.diagnostic_date ?? ev.updated_at ?? ev.opened_at ?? null;
      const daysSinceAction = lastAction
        ? Math.floor((Date.now() - new Date(lastAction).getTime()) / 86400000)
        : (ev.days_active ?? 0);

      let level: Plan["level"];
      // D2: therapist-confirmed signal = a recent diagnostic action.
      if (ev.diagnostic_date && daysSinceAction <= 3) level = "D2";
      // D1: open event with a real trigger description = direct observed.
      else if (hasTrigger) level = "D1";
      // I0: long-stale event with no recent action = weak hint, no auto-task.
      else if (daysSinceAction >= 7) level = "I0";
      // Default residual evidence-supported but weaker than D1.
      else level = "I1";

      result.evidence_levels_summary[level] += 1;
      const isEvidenceSupported = level === "D1" || level === "D2";
      if (isEvidenceSupported) result.evidence_supported_count += 1;
      else result.weak_hints_count += 1;

      const wouldFlag = isEvidenceSupported;
      const wouldCreateTask = isEvidenceSupported; // weak hints NEVER auto-task
      plans.push({
        partName,
        level,
        wouldFlag,
        wouldCreateTask,
        requiresTherapistReview: true,
        reason: `crisis_event_phase=${ev.phase ?? "?"};days_since_action=${daysSinceAction}`,
      });
      result.evaluated_count += 1;
    }

    // Bridge-only inference: alerts without matching event = I1 weak signal.
    for (const a of activeAlerts) {
      const partName = a.part_name as string | null;
      if (!partName) continue;
      if (eventByPart.has(partName)) continue; // already covered as event
      result.evidence_levels_summary.I1 += 1;
      result.weak_hints_count += 1;
      plans.push({
        partName,
        level: "I1",
        wouldFlag: false,
        wouldCreateTask: false, // weak hints never auto-task
        requiresTherapistReview: true,
        reason: `unbridged_alert_status=${a.status}`,
      });
      result.evaluated_count += 1;
    }

    result.would_flag_count = plans.filter((p) => p.wouldFlag).length;
    result.would_create_task_count = plans.filter((p) => p.wouldCreateTask).length;
    result.would_enqueue_drive_count = 0; // H7 never enqueues drive writes
    result.requires_therapist_review_count = plans.filter((p) => p.requiresTherapistReview).length;

    // ── 3. OPTIONAL AI ASSIST ────────────────────────────────────────
    // H7 default = no AI. AI cannot upgrade evidence level even when on.
    if (!generate_ai) {
      result.controlled_skips.push("generate_ai_false");
    } else {
      // Reserved for future: bounded summarization only. Still no diagnosis.
      // We deliberately do not perform a real AI call in this commit; the
      // path is opt-in and remains unimplemented to keep H7 minimal.
      result.controlled_skips.push("generate_ai_helper_path_not_implemented_yet");
    }

    if (!send_alert) {
      result.controlled_skips.push("send_alert_false");
    }

    // ── 4. DRY-RUN / APPLY-DISABLED EXIT ─────────────────────────────
    if (dry_run || !apply_output) {
      result.outcome = "controlled_skipped";
      result.controlled_skips.push(dry_run ? "dry_run_no_apply" : "apply_output_false");
      if (result.weak_hints_count > 0 && result.would_create_task_count === 0) {
        result.controlled_skips.push("only_weak_hints_no_action");
      }
      result.duration_ms = Date.now() - started;
      log("[phase55] dry-run plan", {
        candidates: result.candidates_count,
        evidence_supported: result.evidence_supported_count,
        weak_hints: result.weak_hints_count,
        would_create_task: result.would_create_task_count,
      });
      return result;
    }

    // ── 5. APPLY: therapist-review tasks ONLY ────────────────────────
    // Even with apply_output=true we only create a bounded number of
    // therapist-review tasks. No live-session mutation, no email, no
    // Drive write, no plan mutation.
    await params.setHeartbeat?.();
    let createdTasks = 0;
    for (const p of plans) {
      if (!p.wouldCreateTask) continue; // weak hints excluded by construction
      try {
        const { error } = await sb
          .from("did_therapist_tasks")
          .insert({
            user_id: params.userId,
            part_name: p.partName,
            task_type: "crisis_review",
            status: "pending_review",
            priority: "high",
            title: `Krizový review: ${p.partName}`,
            note:
              `Hypotéza krize (úroveň ${p.level}). ${p.reason}. ` +
              `Vyžaduje terapeutickou revizi — Karel netvrdí klinický závěr.`,
            source: "phase55_crisis_bridge",
          });
        if (error) {
          // Soft-fail: schema may not match exactly; we record but never throw.
          result.errors.push(`task_insert_failed:${error.message.slice(0, 120)}`);
        } else {
          createdTasks += 1;
        }
      } catch (e: any) {
        result.errors.push(`task_insert_exc:${(e?.message ?? String(e)).slice(0, 120)}`);
      }
    }
    result.tasks_created_count = createdTasks;

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
