// FÁZE 3 — CANONICAL CRISIS RESOLVER
// Single source of truth for "is there an open crisis?".
// crisis_events = canonical. crisis_alerts = projection / notification only.

export const OPEN_PHASE_FILTER = ["closed", "CLOSED"] as const;

export interface CanonicalCrisis {
  id: string;
  partName: string;
  severity: string | null;
  phase: string;
  daysActive: number | null;
  openedAt: string | null;
  primaryTherapist: string | null;
  triggerDescription: string | null;
  // Enrichment from crisis_alerts (notifications only — never authoritative)
  alertId?: string | null;
  alertSummary?: string | null;
}

/**
 * Resolve all currently active crisis events (canonical).
 * crisis_alerts is used ONLY to enrich severity/summary when missing on the event,
 * never to decide whether a crisis is "open".
 */
export async function resolveActiveCrises(sb: any): Promise<CanonicalCrisis[]> {
  const { data: events } = await sb
    .from("crisis_events")
    .select("id, part_name, severity, phase, days_active, opened_at, primary_therapist, trigger_description")
    .not("phase", "in", `(${OPEN_PHASE_FILTER.map((p) => `"${p}"`).join(",")})`)
    .order("opened_at", { ascending: false });

  if (!events || events.length === 0) return [];

  const partNames = events.map((e: any) => e.part_name).filter(Boolean);
  const { data: alerts } = await sb
    .from("crisis_alerts")
    .select("id, part_name, severity, summary, status")
    .in("part_name", partNames)
    .in("status", ["ACTIVE", "ACKNOWLEDGED"]);

  const alertMap = new Map<string, any>();
  for (const a of alerts || []) {
    if (!alertMap.has(a.part_name)) alertMap.set(a.part_name, a);
  }

  return events.map((e: any) => {
    const enrich = alertMap.get(e.part_name);
    return {
      id: e.id,
      partName: e.part_name,
      severity: e.severity || enrich?.severity || null,
      phase: e.phase,
      daysActive: e.days_active,
      openedAt: e.opened_at,
      primaryTherapist: e.primary_therapist,
      triggerDescription: e.trigger_description,
      alertId: enrich?.id ?? null,
      alertSummary: enrich?.summary ?? null,
    };
  });
}

/**
 * Resolve the active canonical crisis_event_id for a part.
 * Returns null if no open crisis. crisis_alerts is NOT consulted as authority.
 */
export async function resolveCrisisIdForPart(sb: any, partName: string): Promise<string | null> {
  if (!partName) return null;
  const { data } = await sb
    .from("crisis_events")
    .select("id, opened_at")
    .eq("part_name", partName)
    .not("phase", "in", `(${OPEN_PHASE_FILTER.map((p) => `"${p}"`).join(",")})`)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
