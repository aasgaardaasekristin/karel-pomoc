/**
 * classifiedActionExecutor.ts
 *
 * Executes materialized actions from the information classifier.
 * Writes to DB tables and enqueues Drive writes via governance.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ClassifiedItem,
  materializeActions,
  resolveTarget,
  applySafetyFilter,
  isWriteAllowed,
} from "./informationClassifier.ts";

const DID_OWNER_ID = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";

export interface ExecutionResult {
  drive_writes: number;
  tasks_created: number;
  session_plans_created: number;
  questions_created: number;
  meeting_triggers: number;
  crisis_escalations: number;
  privacy_blocked: number;
}

/**
 * Execute all classified items: write to Drive queue + create DB actions.
 */
export async function executeClassifiedItems(
  sb: SupabaseClient,
  items: ClassifiedItem[],
  sourceDateLabel: string,
  callerName: string,
): Promise<ExecutionResult> {
  const result: ExecutionResult = {
    drive_writes: 0,
    tasks_created: 0,
    session_plans_created: 0,
    questions_created: 0,
    meeting_triggers: 0,
    crisis_escalations: 0,
    privacy_blocked: 0,
  };

  for (const item of items) {
    // ── 1. Drive write (if applicable) ──
    const route = resolveTarget(item);
    if (route) {
      if (!isWriteAllowed(item, route.target_document)) {
        console.warn(`[${callerName}] Privacy blocked: ${item.info_class} → ${route.target_document}`);
        result.privacy_blocked++;
      } else {
        const safeContent = applySafetyFilter(item);
        const datePrefix = `\n\n--- ${sourceDateLabel} | ${item.source} ---\n`;

        await sb.from("did_pending_drive_writes").insert({
          target_document: route.target_document,
          content: route.write_type === "replace"
            ? safeContent
            : `${datePrefix}${safeContent}`,
          write_type: route.write_type,
          priority: "normal",
          status: "pending",
          user_id: DID_OWNER_ID,
        });
        result.drive_writes++;
      }
    }

    // ── 2. Materialize actions ──
    const actions = materializeActions(item, DID_OWNER_ID);

    // Tasks
    for (const task of actions.tasks) {
      await sb.from("did_therapist_tasks").insert({
        title: task.title,
        task: task.title,
        assigned_to: task.assigned_to,
        priority: task.priority,
        status: task.status,
        source: task.source,
        user_id: task.user_id,
      });
      result.tasks_created++;
    }

    // Session plans → did_daily_session_plans
    for (const sp of actions.sessionPlans) {
      await sb.from("did_daily_session_plans").insert({
        part_name: sp.part_name,
        therapist: sp.therapist,
        session_goal: sp.session_goal,
        diagnostic_goal: sp.diagnostic_goal || null,
        stabilization_goal: sp.stabilization_goal || null,
        relational_goal: sp.relational_goal || null,
        risk_point: sp.risk_point || null,
        questions_after: sp.questions_after || [],
        tandem_recommended: sp.tandem_recommended || false,
        source: callerName,
        plan_date: sourceDateLabel,
        status: "planned",
      });
      result.session_plans_created++;
    }

    // Pending questions
    for (const q of actions.pendingQuestions) {
      await sb.from("did_pending_questions").insert({
        question: q.question,
        directed_to: q.directed_to,
        subject_type: q.subject_type,
        subject_id: q.subject_id || null,
        context: q.context || null,
        status: q.status,
      });
      result.questions_created++;
    }

    // Meeting triggers
    for (const mt of actions.meetingTriggers) {
      await sb.from("did_meetings").insert({
        topic: mt.reason,
        status: "requested",
        priority: mt.priority,
        requested_by: "karel",
        user_id: DID_OWNER_ID,
      });
      result.meeting_triggers++;
    }

    // Crisis escalations
    for (const ce of actions.crisisEscalations) {
      await sb.from("crisis_alerts").insert({
        part_name: ce.part_name || "system",
        severity: "high",
        summary: ce.description,
        status: "open",
      });
      result.crisis_escalations++;
    }

    // Card updates (additional KARTA writes from actions)
    for (const cu of actions.cardUpdates) {
      await sb.from("did_pending_drive_writes").insert({
        target_document: `KARTA_${cu.part_name.toUpperCase()}`,
        content: `\n\n--- ${sourceDateLabel} | ${callerName} ---\n${cu.content}`,
        write_type: "append",
        priority: "normal",
        status: "pending",
        user_id: DID_OWNER_ID,
      });
      result.drive_writes++;
    }
  }

  return result;
}
