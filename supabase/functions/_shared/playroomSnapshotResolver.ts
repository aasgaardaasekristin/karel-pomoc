// Pure resolver for the approved Playroom snapshot.
// Reads EXCLUSIVELY urgency_breakdown.playroom_plan_snapshot.payload.
// No fallback to live playroom_plan. Returns a stable diagnostic shape.
//
// Extracted from karel-chat/index.ts so it can be unit-tested with an
// injected supabase-like client (no live network, no auth).

export type PlayroomSnapshotResult =
  | {
      ok: true;
      plan_id: string;
      program_status: string | null;
      version_key: string | null;
      snapshot_at: string | null;
      playroom_plan: any;
      source: "snapshot";
    }
  | { ok: false; reason: string; plan_id: string | null };

export interface PlayroomSnapshotClient {
  from: (table: string) => any;
}

export interface ResolvePlayroomSnapshotDeps {
  sb: PlayroomSnapshotClient;
  today: string; // YYYY-MM-DD in Europe/Prague
}

export async function resolvePlayroomSnapshot(
  partName: string | null | undefined,
  deps: ResolvePlayroomSnapshotDeps,
): Promise<PlayroomSnapshotResult> {
  if (!partName) return { ok: false, reason: "missing_part_name", plan_id: null };
  try {
    const { data, error } = await deps.sb
      .from("did_daily_session_plans")
      .select("id,plan_date,selected_part,program_status,urgency_breakdown")
      .eq("plan_date", deps.today)
      .ilike("selected_part", partName)
      .contains("urgency_breakdown", {
        session_actor: "karel_direct",
        ui_surface: "did_kids_playroom",
        lead_entity: "karel",
      })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, reason: "db_error:" + error.message, plan_id: null };
    if (!data) return { ok: false, reason: "no_approved_plan_today", plan_id: null };
    const contract = data.urgency_breakdown && typeof data.urgency_breakdown === "object"
      ? (data.urgency_breakdown as any)
      : null;
    if (!contract) return { ok: false, reason: "no_urgency_breakdown", plan_id: data.id };
    const snapshot = contract.playroom_plan_snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return { ok: false, reason: "snapshot_missing", plan_id: data.id };
    }
    const payload = snapshot.payload;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.therapeutic_program)) {
      return { ok: false, reason: "snapshot_payload_invalid", plan_id: data.id };
    }
    return {
      ok: true,
      plan_id: data.id,
      program_status: data.program_status ?? null,
      version_key: snapshot.version_key ?? null,
      snapshot_at: snapshot.snapshot_at ?? null,
      playroom_plan: payload,
      source: "snapshot",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "exception:" + msg, plan_id: null };
  }
}

// Build the HTTP response body karel-chat sends with status 409.
// Kept as a single source of truth so the UI contract is tested.
export function buildPlayroomSnapshotUnavailableBody(
  result: Extract<PlayroomSnapshotResult, { ok: false }>,
) {
  return {
    ok: false as const,
    error: "playroom_snapshot_unavailable" as const,
    reason: result.reason,
    plan_id: result.plan_id,
    source: "snapshot" as const,
    message:
      "Herna nemůže být spuštěna: chybí immutable snapshot schváleného programu (playroom_plan_snapshot). Live playroom_plan se jako runtime zdroj nepoužívá.",
  };
}
