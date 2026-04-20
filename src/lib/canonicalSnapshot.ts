// FÁZE 3C — THIN canonical snapshot helpers (FRONTEND IS NOT A RESOLVER).
//
// Tento soubor je VÝLUČNĚ tenká vrstva nad serverovým canonical snapshotem
// (did_daily_context.context_json + canonical_*). NEdotazuje DB jako paralelní
// resolver vedle serveru. Jediná autorita pro "aktivní krize" zůstává:
//   - server canonicalCrisis resolver (supabase/functions/_shared/canonicalCrisis.ts)
//   - did_daily_context.context_json.canonical_crises emitované karel-daily-refresh
//
// Pokud nějaká část UI dnes potřebuje aktivní krize, musí je číst:
//   1) z propsu / kontextu, kterému je server snapshot předán shora, nebo
//   2) přes useCrisisOperationalState (canonical view-model nad crisis_events,
//      jediný legitimní front-end resolver, jehož dotaz odpovídá serverovému
//      canonical filtru).
//
// Tento helper NESMÍ obsahovat raw SELECT proti crisis_events / crisis_alerts.

export const OPEN_PHASE_FILTER = ["closed", "CLOSED"] as const;

/** Server-emitted snapshot shape used by frontend readers. */
export interface CanonicalCrisisSnapshotItem {
  id: string;
  partName: string;
  severity: string | null;
  phase: string;
}

export interface CanonicalQueueSnapshot {
  primary: Array<{
    id: string;
    text: string;
    priority: string | null;
    section: string | null;
    planType: string | null;
    reviewAt: string | null;
  }>;
  adjunct: Array<{
    id: string;
    text: string;
    assignedTo: string | null;
    priority: string | null;
    status: string | null;
    category: string | null;
    dueDate: string | null;
  }>;
  primaryCount: number;
  adjunctCount: number;
}

export interface CanonicalTodaySession {
  id: string;
  selected_part: string | null;
  therapist: string | null;
  session_lead: string | null;
  urgency_score: number | null;
  status: string | null;
  crisis_event_id: string | null;
}

/** ── Pure selectors over already-loaded server snapshots ── */

export function selectCanonicalCrisesFromSnapshot(
  contextJson: any,
): CanonicalCrisisSnapshotItem[] {
  if (!contextJson) return [];
  const legacy = (contextJson.legacy ?? contextJson) as any;
  const list = Array.isArray(contextJson.canonical_crises)
    ? contextJson.canonical_crises
    : Array.isArray(legacy?.command?.crises)
      ? legacy.command.crises
      : [];
  return list as CanonicalCrisisSnapshotItem[];
}

export function selectCanonicalCrisisCountFromSnapshot(contextJson: any): number {
  if (typeof contextJson?.canonical_crisis_count === "number") {
    return contextJson.canonical_crisis_count;
  }
  return selectCanonicalCrisesFromSnapshot(contextJson).length;
}

export function selectCanonicalTodaySessionFromSnapshot(
  contextJson: any,
): CanonicalTodaySession | null {
  return (contextJson?.canonical_today_session ?? null) as CanonicalTodaySession | null;
}

export function selectCanonicalQueueFromSnapshot(
  contextJson: any,
): CanonicalQueueSnapshot {
  const q = contextJson?.canonical_queue;
  const primary = Array.isArray(q?.primary) ? q.primary : [];
  const adjunct = Array.isArray(q?.adjunct) ? q.adjunct : [];
  return {
    primary,
    adjunct,
    primaryCount: typeof q?.primary_count === "number" ? q.primary_count : primary.length,
    adjunctCount: typeof q?.adjunct_count === "number" ? q.adjunct_count : adjunct.length,
  };
}
