import React from "react";
import { Shield, ChevronDown, ChevronUp, Bell, Clock } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import { useCrisisDetail } from "@/contexts/CrisisDetailContext";

/**
 * CrisisAlert — SIGNALIZAČNÍ vrstva (Crisis Detail UX Repair Pass, 2026-04-21).
 *
 * ROLE:
 *   - Stručně signalizovat aktivní krize.
 *   - Jediný CTA: „Otevřít detail" → otevře pracovní plochu
 *     (`CrisisDetailWorkspace` jako right-side Sheet drawer).
 *   - Stejnou plochu otevírá i „Otevřít detail" v Karlově přehledu —
 *     společný owner = `useCrisisDetail()`.
 *
 * Banner už nikdy:
 *   - nedělá inline accordion s detailem
 *   - nenosí ownership / deficit / workflow
 *   - není dvojí zdroj pravdy pro „kde je detail"
 */

const STATE_LABELS: Record<string, string> = {
  active: "aktivní",
  intervened: "po zásahu",
  stabilizing: "stabilizace",
  awaiting_session_result: "čeká výsledek",
  awaiting_therapist_feedback: "čeká feedback",
  ready_for_joint_review: "k poradě",
  ready_to_close: "k uzavření",
  closed: "uzavřeno",
  monitoring_post: "monitoring",
};

const severityAmbient = (severity: string) => {
  switch (severity?.toLowerCase()) {
    case "critical":
      return {
        bg: "hsl(8 30% 97%)",
        border: "hsl(8 35% 85%)",
        accent: "hsl(8 50% 42%)",
        muted: "hsl(8 30% 55%)",
      };
    case "high":
    case "elevated":
      return {
        bg: "hsl(20 30% 97%)",
        border: "hsl(20 35% 85%)",
        accent: "hsl(20 50% 40%)",
        muted: "hsl(20 30% 50%)",
      };
    case "moderate":
      return {
        bg: "hsl(38 25% 97%)",
        border: "hsl(38 30% 85%)",
        accent: "hsl(38 45% 35%)",
        muted: "hsl(38 25% 50%)",
      };
    default:
      return {
        bg: "hsl(34 15% 97%)",
        border: "hsl(34 20% 88%)",
        accent: "hsl(34 30% 40%)",
        muted: "hsl(34 20% 55%)",
      };
  }
};

const CrisisAlert: React.FC = () => {
  const { cards, loading, globalUnreadBriefCount } = useCrisisOperationalState();
  const { activeCardId, openCrisisDetail, closeCrisisDetail } = useCrisisDetail();

  if (loading || cards.length === 0) return null;

  return (
    <div className="sticky top-0 z-50">
      {globalUnreadBriefCount > 0 && (
        <div
          className="px-3 py-0.5 flex items-center justify-center gap-1.5 text-[11px]"
          style={{
            backgroundColor: "hsl(8 20% 95%)",
            color: "hsl(8 40% 35%)",
            borderBottom: "1px solid hsl(8 20% 85%)",
          }}
        >
          <Bell className="w-3 h-3" />
          {globalUnreadBriefCount} nepřečtený brief{globalUnreadBriefCount > 1 ? "y" : ""}
        </div>
      )}

      {cards.map((card: CrisisOperationalCard) => {
        const id = card.eventId || card.alertId || card.partName;
        const isActive = activeCardId === id;
        const stateLabel = card.operatingState
          ? STATE_LABELS[card.operatingState] || card.operatingState
          : "aktivní";
        const ambient = severityAmbient(card.severity);

        return (
          <div key={id}>
            <div
              className="transition-colors"
              style={{
                backgroundColor: ambient.bg,
                borderBottom: `1px solid ${ambient.border}`,
                borderLeft: `2px solid ${ambient.accent}`,
              }}
            >
              <div className="max-w-[900px] mx-auto px-3 py-1.5">
                <div className="flex items-center gap-2 text-[12px] leading-tight">
                  <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: ambient.muted }} />

                  <span className="font-medium truncate" style={{ color: ambient.accent }}>
                    {card.displayName}
                  </span>

                  <span
                    className="text-[10px] px-1 py-0.5 rounded-sm font-normal leading-none"
                    style={{
                      backgroundColor: "transparent",
                      color: ambient.accent,
                      border: `1px solid ${ambient.border}`,
                    }}
                  >
                    {card.severity}
                  </span>

                  <span className="text-[10px] whitespace-nowrap" style={{ color: ambient.muted }}>
                    {stateLabel}
                  </span>

                  {card.daysActive != null && (
                    <span className="text-[10px] whitespace-nowrap" style={{ color: ambient.muted, opacity: 0.8 }}>
                      den {card.daysActive}
                    </span>
                  )}

                  {card.isStale && (
                    <span
                      className="text-[10px] flex items-center gap-1 whitespace-nowrap"
                      style={{ color: ambient.muted, opacity: 0.85 }}
                    >
                      <Clock className="w-3 h-3" />
                      {Math.round(card.hoursStale)}h
                    </span>
                  )}

                  <button
                    onClick={() => (isActive ? closeCrisisDetail() : openCrisisDetail(id))}
                    className="ml-auto flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors"
                    style={{
                      color: ambient.muted,
                      backgroundColor: "transparent",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = ambient.accent;
                      e.currentTarget.style.backgroundColor = "hsl(0 0% 100% / 0.3)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = ambient.muted;
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    aria-label={isActive ? "Zavřít detail krize" : "Otevřít detail krize"}
                  >
                    {isActive ? (
                      <>
                        Zavřít <ChevronUp className="w-3 h-3" />
                      </>
                    ) : (
                      <>
                        Detail <ChevronDown className="w-3 h-3" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CrisisAlert;
