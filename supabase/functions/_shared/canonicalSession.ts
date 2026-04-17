// FÁZE 3 — CANONICAL SESSION RESOLVER
// Single source of truth for today's session reality.
// did_daily_session_plans = canonical.
// planned_sessions / next_session_plan / part_goals / strategic_goals = inputs / projection only.

export const PLAN_ACTIVE_STATUSES = ["pending", "planned", "generated", "in_progress"] as const;

export interface CanonicalSession {
  id: string;
  planDate: string;
  selectedPart: string | null;
  therapist: string | null;
  sessionLead: string | null;
  sessionFormat: string | null;
  urgencyScore: number | null;
  urgencyBreakdown: any;
  status: string;
  planMarkdown: string | null;
  crisisEventId: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

function mapRow(r: any): CanonicalSession {
  return {
    id: r.id,
    planDate: r.plan_date,
    selectedPart: r.selected_part,
    therapist: r.therapist,
    sessionLead: r.session_lead,
    sessionFormat: r.session_format,
    urgencyScore: r.urgency_score,
    urgencyBreakdown: r.urgency_breakdown,
    status: r.status,
    planMarkdown: r.plan_markdown,
    crisisEventId: r.crisis_event_id ?? null,
    completedAt: r.completed_at ?? null,
    createdAt: r.created_at ?? null,
  };
}

/**
 * All today's canonical sessions (status active or already completed for the day).
 */
export async function resolveTodaysSessions(sb: any, pragueDate: string): Promise<CanonicalSession[]> {
  const { data } = await sb
    .from("did_daily_session_plans")
    .select("*")
    .eq("plan_date", pragueDate)
    .order("urgency_score", { ascending: false });
  return (data || []).map(mapRow);
}

/**
 * Primary today's session for a given part (highest urgency, active status preferred).
 */
export async function resolvePrimarySessionForPart(
  sb: any,
  partName: string,
  pragueDate: string,
): Promise<CanonicalSession | null> {
  if (!partName) return null;
  const { data } = await sb
    .from("did_daily_session_plans")
    .select("*")
    .eq("plan_date", pragueDate)
    .eq("selected_part", partName)
    .in("status", PLAN_ACTIVE_STATUSES as unknown as string[])
    .order("urgency_score", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? mapRow(data) : null;
}

/**
 * Get the meeting bound to a daily plan (canonical linkage), or null.
 */
export async function hydrateSessionMeeting(sb: any, dailyPlanId: string): Promise<any | null> {
  if (!dailyPlanId) return null;
  const { data } = await sb
    .from("did_meetings")
    .select("id, topic, status, created_at, updated_at, daily_plan_id, messages")
    .eq("daily_plan_id", dailyPlanId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}
