/**
 * activityStatusGuard.ts — Phase 3
 *
 * Determines what actions are permissible for a given DID entity
 * based on its activity status and evidence.
 *
 * RULES:
 * - direct_activity (sub_mode=cast within 7 days) → can plan direct contact
 * - therapist_mention only → cannot pretend direct activity, only monitoring
 * - dormant (no direct activity 30+ days) → card updates only, or campaign planning
 * - activation_candidate → can plan activation campaign, NOT direct therapy
 *
 * Single responsibility: activity classification + permission derivation.
 */

import type {
  EntityActivityStatus,
  EntityActivityAssessment,
} from "./phase3Types.ts";

// ── Constants ──

/** Days since last direct contact to consider a child "dormant" */
const DORMANT_THRESHOLD_DAYS = 30;

/** Days since last direct contact to consider activity "recent" */
const RECENT_ACTIVITY_THRESHOLD_DAYS = 7;

// ── Core Assessment ──

export interface ActivityEvidenceInput {
  entityName: string;
  entityKind: "did_child" | "therapist" | "biological_person" | "animal" | "other";
  lastDirectThreadDate: string | null;  // ISO date of most recent sub_mode="cast" thread
  lastTherapistMentionDate: string | null;
  recentDirectThreadCount: number;      // threads in last 7 days
}

/**
 * Assess the activity status of an entity and derive permissions.
 */
export function assessActivityStatus(
  input: ActivityEvidenceInput,
  now: Date = new Date(),
): EntityActivityAssessment {
  const reasons: string[] = [];

  // Non-DID entities have fixed permissions
  if (input.entityKind !== "did_child") {
    return {
      entityName: input.entityName,
      entityKind: input.entityKind,
      activityStatus: "unknown",
      lastDirectActivity: input.lastDirectThreadDate,
      lastMentionedAt: input.lastTherapistMentionDate,
      daysSinceDirectContact: null,
      evidenceSources: [],
      canReceiveDirectTask: false,
      canReceiveMonitoringTask: input.entityKind === "therapist",
      canReceiveCampaignPlan: false,
      reasons: [`Entity kind "${input.entityKind}" — not a DID child`],
    };
  }

  // Calculate days since last direct contact
  let daysSinceDirect: number | null = null;
  if (input.lastDirectThreadDate) {
    const lastDirect = new Date(input.lastDirectThreadDate);
    daysSinceDirect = Math.floor((now.getTime() - lastDirect.getTime()) / (1000 * 60 * 60 * 24));
  }

  // Determine activity status
  let status: EntityActivityStatus;

  if (input.recentDirectThreadCount > 0 && daysSinceDirect !== null && daysSinceDirect <= RECENT_ACTIVITY_THRESHOLD_DAYS) {
    status = "active_in_body";
    reasons.push(`Direct activity within ${daysSinceDirect} days (${input.recentDirectThreadCount} threads)`);
  } else if (daysSinceDirect !== null && daysSinceDirect <= DORMANT_THRESHOLD_DAYS) {
    status = "active_inner_world";
    reasons.push(`Last direct contact ${daysSinceDirect} days ago — not recently active but not dormant`);
  } else if (input.lastTherapistMentionDate && !input.lastDirectThreadDate) {
    status = "mentioned_by_therapist";
    reasons.push("Only therapist mentions, no direct activity ever recorded");
  } else if (daysSinceDirect !== null && daysSinceDirect > DORMANT_THRESHOLD_DAYS) {
    status = "dormant";
    reasons.push(`No direct contact for ${daysSinceDirect} days — dormant`);
  } else if (!input.lastDirectThreadDate && !input.lastTherapistMentionDate) {
    status = "unknown";
    reasons.push("No activity data available");
  } else {
    status = "unknown";
    reasons.push("Insufficient data for classification");
  }

  // Derive permissions
  const canReceiveDirectTask = status === "active_in_body";
  const canReceiveMonitoringTask = status !== "unknown";
  // Campaign plan requires stronger evidence than a mere therapist mention.
  // "mentioned_by_therapist" only allows monitoring + card updates.
  // Campaign eligibility requires "dormant" status (confirmed prior direct activity,
  // now gone silent) or explicit "activation_candidate" override from higher-level logic.
  const canReceiveCampaignPlan = status === "dormant";

  if (!canReceiveDirectTask && status !== "unknown") {
    reasons.push("Direct tasks blocked — child is not confirmed active in body");
  }
  if (canReceiveCampaignPlan) {
    reasons.push("Eligible for planned activation campaign");
  }

  return {
    entityName: input.entityName,
    entityKind: input.entityKind,
    activityStatus: status,
    lastDirectActivity: input.lastDirectThreadDate,
    lastMentionedAt: input.lastTherapistMentionDate,
    daysSinceDirectContact: daysSinceDirect,
    evidenceSources: [],
    canReceiveDirectTask,
    canReceiveMonitoringTask,
    canReceiveCampaignPlan,
    reasons,
  };
}
