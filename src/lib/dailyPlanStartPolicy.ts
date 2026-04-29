export interface DailyPlanStartRow {
  program_status?: string | null;
  approved_at?: string | null;
  urgency_breakdown?: Record<string, any> | null;
}

export function planApprovalSynced(plan?: DailyPlanStartRow | null) {
  const contract =
    plan?.urgency_breakdown && typeof plan.urgency_breakdown === "object"
      ? plan.urgency_breakdown
      : {};
  const approvalSync = contract.approval_sync ?? {};
  return (
    approvalSync.status === "synced" &&
    !!approvalSync.program_draft_hash &&
    !!approvalSync.plan_markdown_hash &&
    !!plan?.approved_at &&
    ["approved", "ready_to_start", "in_progress"].includes(
      String(plan?.program_status ?? "").toLowerCase(),
    )
  );
}

export function liveStartStatusText(args: {
  signed: boolean;
  starting: boolean;
  plan?: DailyPlanStartRow | null;
  lastErrorCode?: string | null;
}) {
  if (!args.signed) return null;
  if (args.starting) return "Synchronizuji schválení…";
  if (args.lastErrorCode) {
    return "Porada je podepsaná, ale plán stále není bezpečně připravený ke spuštění.";
  }
  if (planApprovalSynced(args.plan)) return "Připraveno k zahájení";
  return "Schváleno v poradě, čeká na propsání schválení do denního plánu.";
}
