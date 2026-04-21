import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp, Bell, Clock } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";

/**
 * CrisisAlert — SIGNALIZAČNÍ vrstva (Crisis Function Reallocation Repair Pass, 2026-04-21).
 *
 * ROLE (po reallocaci):
 *   - Stručně signalizovat, že existuje aktivní krize.
 *   - Ukázat IDENTITU části, severity, operating state, den krize.
 *   - Případně "Xh bez kontaktu" jako jediný klinicky-relevantní časový signál.
 *   - Jediný CTA: "Otevřít detail".
 *
 * CO SEM UŽ NEPATŘÍ (přesunuto do Karlova přehledu / detailu):
 *   - primaryTherapist (ownership leakage — krizi řeší tým, ne jméno v banneru)
 *   - missingTodayInterview (Karlův pracovní deficit → Karlův přehled)
 *   - missingTherapistFeedback (Karlův pracovní deficit → Karlův přehled)
 *
 * VIZUÁLNÍ PRINCIPY:
 *   - Klidné, profesionální, terapeutické
 *   - Jeden řádek, kompaktní, bez druhé řady deficitních statusů
 *   - Severity jako jemný ambientní tón, ne dominantní badge
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

// ── Severity → kultivovaný HSL ambient (jemný, ne křiklavý) ──
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
  const { cards, loading, refetch, globalUnreadBriefCount } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading || cards.length === 0) return null;

  return (
    <div className="sticky top-0 z-50">
      {/* ── Globální brief indicator (nepřehnaný, jemný) ── */}
      {globalUnreadBriefCount > 0 && (
        <div
          className="px-4 py-1 flex items-center justify-center gap-1.5 text-[11px]"
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
        const isExpanded = expandedId === id;
        const stateLabel = card.operatingState
          ? STATE_LABELS[card.operatingState] || card.operatingState
          : "aktivní";
        const ambient = severityAmbient(card.severity);

        return (
          <div key={id}>
            {/* ── Banner row — jediný řádek, signalizace, žádný workflow toolbar ── */}
            <div
              className="transition-colors"
              style={{
                backgroundColor: ambient.bg,
                borderBottom: `1px solid ${ambient.border}`,
                borderLeft: `2px solid ${ambient.accent}`,
              }}
            >
              <div className="max-w-[900px] mx-auto px-4 py-2.5">
                <div className="flex items-center gap-3 text-[13px]">
                  {/* Ikona jako jemný akcent */}
                  <Shield className="w-4 h-4 shrink-0" style={{ color: ambient.muted }} />

                  {/* Identita části */}
                  <span className="font-medium" style={{ color: ambient.accent }}>
                    {card.displayName}
                  </span>

                  {/* Severity — jemný textový tag */}
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded-sm font-normal"
                    style={{
                      backgroundColor: "transparent",
                      color: ambient.accent,
                      border: `1px solid ${ambient.border}`,
                    }}
                  >
                    {card.severity}
                  </span>

                  {/* Operating state */}
                  <span className="text-[11px]" style={{ color: ambient.muted }}>
                    {stateLabel}
                  </span>

                  {/* Den krize */}
                  {card.daysActive != null && (
                    <span className="text-[11px]" style={{ color: ambient.muted, opacity: 0.8 }}>
                      den {card.daysActive}
                    </span>
                  )}

                  {/* Xh bez kontaktu — jediný klinicky-relevantní časový signál */}
                  {card.isStale && (
                    <span
                      className="text-[11px] flex items-center gap-1"
                      style={{ color: ambient.muted, opacity: 0.85 }}
                    >
                      <Clock className="w-3 h-3" />
                      {Math.round(card.hoursStale)}h bez kontaktu
                    </span>
                  )}

                  {/* Jediný CTA — vpravo */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                    className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors"
                    style={{
                      color: ambient.accent,
                      backgroundColor: "transparent",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = "hsl(0 0% 100% / 0.4)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    aria-label={isExpanded ? "Zavřít detail krize" : "Otevřít detail krize"}
                  >
                    {isExpanded ? (
                      <>
                        Zavřít <ChevronUp className="w-3.5 h-3.5" />
                      </>
                    ) : (
                      <>
                        Otevřít detail <ChevronDown className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Detail (operativní karta) ── */}
            {isExpanded && (
              <CrisisOperationalDetail card={card} onRefetch={refetch} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CrisisAlert;
