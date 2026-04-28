import type { AppModePolicy } from "@/lib/appModePolicy";
import type { SafetyDetectionResult } from "@/lib/safetyDetection";

interface ModeAuditPanelProps {
  policy: AppModePolicy;
  noSave: boolean;
  lastSafetyDetection: SafetyDetectionResult | null;
  lastWritebackDecision: string;
}

const formatValue = (value: string | boolean | null | undefined) => {
  if (value === true) return "ano";
  if (value === false) return "ne";
  return value || "—";
};

const ModeAuditPanel = ({ policy, noSave, lastSafetyDetection, lastWritebackDecision }: ModeAuditPanelProps) => {
  const fields = [
    ["mode_id", policy.mode_id],
    ["save_policy", policy.save_policy],
    ["did_relevance_policy", policy.did_relevance_policy],
    ["pantry_policy", policy.pantry_policy],
    ["drive_policy", policy.drive_policy],
    ["daily_briefing_policy", policy.daily_briefing_policy],
    ["no_history / no_save", noSave],
    ["safety_policy", policy.safety_policy],
    ["last_safety_detection", lastSafetyDetection ? `${lastSafetyDetection.category ?? "matched"} / ${lastSafetyDetection.required_response_style}` : "—"],
    ["last_writeback_decision", lastWritebackDecision],
    ["allows_did_writeback", policy.allows_did_writeback],
  ] as const;

  return (
    <details className="border-b border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-secondary))]/45 px-4 py-2 text-xs text-[hsl(var(--text-secondary))]">
      <summary className="mx-auto max-w-4xl cursor-pointer font-medium text-[hsl(var(--text-primary))]">
        Zobrazit audit režimu
      </summary>
      <div className="mx-auto mt-3 grid max-w-4xl gap-2 sm:grid-cols-2">
        {noSave && (
          <div className="sm:col-span-2 rounded-lg border border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary))]/50 p-3">
            <p>Persistentní zápisy: vypnuto</p>
            <p>Pantry B: vypnuto</p>
            <p>Drive: vypnuto</p>
            <p>Daily briefing: vypnuto</p>
            <p>Safety audit: pouze minimální/redigovaný při akutním riziku</p>
          </div>
        )}
        {fields.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary))]/40 p-2">
            <div className="font-medium text-[hsl(var(--text-tertiary))]">{label}</div>
            <div className="mt-0.5 break-words text-[hsl(var(--text-primary))]">{formatValue(value)}</div>
          </div>
        ))}
      </div>
    </details>
  );
};

export default ModeAuditPanel;