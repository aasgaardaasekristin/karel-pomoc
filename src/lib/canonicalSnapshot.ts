// FÁZE 3 — Frontend canonical selectors (THIN ONLY).
// These are NOT a parallel resolver. They are read-only selectors over server snapshots
// and minimal direct queries that mirror the server canonical filter.
// All decisive truth still lives in canonical resolvers on the server side.

import { supabase } from "@/integrations/supabase/client";

export const OPEN_PHASE_FILTER = ["closed", "CLOSED"] as const;

export interface UICanonicalCrisis {
  id: string;
  partName: string;
  severity: string | null;
  phase: string;
  openedAt: string | null;
  alertId?: string | null;
  alertSummary?: string | null;
}

/**
 * Resolve active crises directly (mirrors server canonicalCrisis.ts).
 * Used only when no fresher server snapshot is available.
 */
export async function selectActiveCrises(): Promise<UICanonicalCrisis[]> {
  const { data: events } = await supabase
    .from("crisis_events")
    .select("id, part_name, severity, phase, opened_at")
    .not("phase", "in", `(${OPEN_PHASE_FILTER.map((p) => `"${p}"`).join(",")})`)
    .order("opened_at", { ascending: false });
  if (!events || events.length === 0) return [];

  const partNames = events.map((e: any) => e.part_name).filter(Boolean);
  const { data: alerts } = await supabase
    .from("crisis_alerts")
    .select("id, part_name, severity, summary, status")
    .in("part_name", partNames)
    .in("status", ["ACTIVE", "ACKNOWLEDGED"]);

  const alertMap = new Map<string, any>();
  for (const a of alerts || []) {
    if (!alertMap.has(a.part_name)) alertMap.set(a.part_name, a);
  }

  return (events as any[]).map((e) => {
    const enrich = alertMap.get(e.part_name);
    return {
      id: e.id,
      partName: e.part_name,
      severity: e.severity || enrich?.severity || null,
      phase: e.phase,
      openedAt: e.opened_at,
      alertId: enrich?.id ?? null,
      alertSummary: enrich?.summary ?? null,
    };
  });
}

/** Resolve canonical crisis_event_id for a part name. Returns null if no open crisis. */
export async function selectCrisisIdForPart(partName: string): Promise<string | null> {
  if (!partName) return null;
  const { data } = await supabase
    .from("crisis_events")
    .select("id")
    .eq("part_name", partName)
    .not("phase", "in", `(${OPEN_PHASE_FILTER.map((p) => `"${p}"`).join(",")})`)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as any)?.id ?? null;
}
