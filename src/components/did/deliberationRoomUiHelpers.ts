import type { TeamDeliberation } from "@/types/teamDeliberation";

function sessionParamsOf(deliberation: Pick<TeamDeliberation, "session_params">) {
  return deliberation.session_params && typeof deliberation.session_params === "object"
    ? (deliberation.session_params as Record<string, unknown>)
    : {};
}

export function isPlayroomDeliberation(
  deliberation: Pick<TeamDeliberation, "session_params"> & { deliberation_type?: unknown },
): boolean {
  const p = sessionParamsOf(deliberation);
  return (
    String(deliberation.deliberation_type) === "playroom" ||
    p.session_actor === "karel_direct" ||
    p.ui_surface === "did_kids_playroom" ||
    p.session_format === "playroom" ||
    Boolean(p.playroom_plan)
  );
}

export function hasActiveExternalCurrentEventReplan(
  deliberation: Pick<TeamDeliberation, "session_params">,
): boolean {
  const p = sessionParamsOf(deliberation);
  const replan = p.external_current_event_replan;
  return !!replan && typeof replan === "object" && (replan as Record<string, unknown>).active === true;
}

export function getPlanChangeLabel(
  deliberation: Pick<TeamDeliberation, "status" | "hanka_signed_at" | "kata_signed_at" | "session_params">,
): string {
  const p = sessionParamsOf(deliberation);
  const replan = p.external_current_event_replan;
  const status = String(deliberation.status ?? "").toLowerCase();

  if (replan && typeof replan === "object" && (replan as Record<string, unknown>).active === true) {
    const rawLabel = (replan as Record<string, unknown>).event_label ?? "externí událost";
    const label = String(rawLabel).trim();
    return label
      ? `vráceno k úpravě po urgentní externí události (${label})`
      : "vráceno k úpravě po urgentní externí události";
  }

  if (status === "in_revision") return "vráceno k úpravě";

  if (deliberation.hanka_signed_at == null || deliberation.kata_signed_at == null) {
    return "čeká na schválení terapeutkami";
  }

  return "beze změny";
}

export function getLiveProgramTitle(
  deliberation: Pick<TeamDeliberation, "deliberation_type" | "session_params">,
): string {
  return isPlayroomDeliberation(deliberation) ? "Živý program Herny" : "Živý program Sezení";
}