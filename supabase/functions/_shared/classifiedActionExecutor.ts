/**
 * classifiedActionExecutor.ts
 *
 * Executes materialized actions from the information classifier.
 * Writes to DB tables and enqueues Drive writes via governance.
 * All Drive writes use governed envelope for full audit trail.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ClassifiedItem,
  materializeActions,
  resolveTarget,
  applySafetyFilter,
  isWriteAllowed,
  mapInfoClassToContentType,
} from "./informationClassifier.ts";
import { encodeGovernedWrite } from "./documentWriteEnvelope.ts";
import { decodeGovernedWrite } from "./documentWriteEnvelope.ts";

const DID_OWNER_ID = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";

/** Operational document targets that require anti-dup protection */
const DEDUP_PROTECTED_TARGETS = [
  "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
  "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
  "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
];

export interface ExecutionResult {
  drive_writes: number;
  tasks_created: number;
  session_plans_created: number;
  questions_created: number;
  meeting_triggers: number;
  crisis_escalations: number;
  privacy_blocked: number;
  dedup_skipped: number;
}

/**
 * Simple deterministic fingerprint for payload dedup.
 * Normalizes whitespace, lowercases, and takes first 200 chars as fingerprint base.
 */
function payloadFingerprint(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/---\s*\d{4}-\d{2}-\d{2}[^-]*---/g, "") // strip date headers
    .trim()
    .slice(0, 200);

  // Simple hash: sum of char codes mod large prime
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `fp-${(hash >>> 0).toString(36)}`;
}

/**
 * Anti-dup guard: check if a write with matching source_id + content_type + subject_id + payload_fingerprint
 * already exists for this target in the last 24h.
 * Only applied to operational docs (05A/05B/05C/DASHBOARD).
 *
 * Uses payload fingerprint so that:
 * - Same signal from same source → blocked (true duplicate)
 * - Different signals from same source for same subject → allowed (different content)
 */
async function isDuplicateWrite(
  sb: SupabaseClient,
  target: string,
  sourceId: string,
  contentType: string,
  subjectId: string,
  payloadContent: string,
): Promise<boolean> {
  if (!DEDUP_PROTECTED_TARGETS.includes(target)) return false;

  const fingerprint = payloadFingerprint(payloadContent);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from("did_pending_drive_writes")
    .select("id, content")
    .eq("target_document", target)
    .eq("user_id", DID_OWNER_ID)
    .gte("created_at", since)
    .limit(100);

  if (!data || data.length === 0) return false;

  for (const row of data) {
    const { payload, metadata } = decodeGovernedWrite(row.content || "");
    if (
      metadata &&
      metadata.source_id === sourceId &&
      metadata.content_type === contentType &&
      metadata.subject_id === subjectId &&
      payloadFingerprint(payload) === fingerprint
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build governed metadata from a classified item.
 */
function buildMetadata(item: ClassifiedItem, callerName: string) {
  const subjectType = item.part_name ? "part"
    : item.therapist ? "therapist"
    : "system";
  return {
    source_type: callerName,
    source_id: item.source_id,
    content_type: mapInfoClassToContentType(item.info_class),
    subject_type: subjectType,
    subject_id: item.part_name || item.therapist || "system",
  };
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
    dedup_skipped: 0,
  };

  for (const item of items) {
    const meta = buildMetadata(item, callerName);

    // ── 1. Drive write (if applicable) ──
    const route = resolveTarget(item);
    if (route) {
      if (!isWriteAllowed(item, route.target_document)) {
        console.warn(`[${callerName}] Privacy blocked: ${item.info_class} → ${route.target_document}`);
        result.privacy_blocked++;
      } else {
          const safeContent = applySafetyFilter(item);
          const datePrefix = `\n\n--- ${sourceDateLabel} | ${item.source} ---\n`;
          const rawPayload = route.write_type === "replace"
            ? safeContent
            : `${datePrefix}${safeContent}`;

          // Anti-dup check for operational docs — now includes payload fingerprint
          const isDup = await isDuplicateWrite(
            sb, route.target_document, item.source_id, meta.content_type, meta.subject_id, rawPayload,
          );
          if (isDup) {
            console.warn(`[${callerName}] Dedup skipped: ${item.info_class} → ${route.target_document} (source_id=${item.source_id}, fingerprint match)`);
            result.dedup_skipped++;
          } else {

          await sb.from("did_pending_drive_writes").insert({
            target_document: route.target_document,
            content: encodeGovernedWrite(rawPayload, meta),
            write_type: route.write_type,
            priority: "normal",
            status: "pending",
            user_id: DID_OWNER_ID,
          });
          result.drive_writes++;
        }
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
      const cardTarget = `KARTA_${cu.part_name.toUpperCase()}`;
      const cardMeta = {
        source_type: callerName,
        source_id: item.source_id,
        content_type: "session_result",
        subject_type: "part",
        subject_id: cu.part_name,
      };

      await sb.from("did_pending_drive_writes").insert({
        target_document: cardTarget,
        content: encodeGovernedWrite(
          `\n\n--- ${sourceDateLabel} | ${callerName} ---\n${cu.content}`,
          cardMeta,
        ),
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
