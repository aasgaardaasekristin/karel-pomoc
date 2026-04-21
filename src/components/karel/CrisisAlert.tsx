import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp, Bell, Users, Clock } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";

/**
 * CrisisAlert — SIGNALIZAČNÍ vrstva (Crisis Banner Repair Pass, 2026-04-21).
 *
 * ROLE:
 *   - Stručně signalizovat, že existuje aktivní krize.
 *   - Ukázat identitu části, severity, operační stav, den krize, čas bez kontaktu.
 *   - 1–2 status badges (display-only).
 *   - Jediný vstup: "Otevřít detail" → expanze do CrisisOperationalDetail.
 *
 * NEDĚLÁ (přesunuto do detailu / porad / therapist rooms):
 *   - "Spustit hodnocení", "Získat feedback", "Otevřít poradu" (Řízení tab v detailu)
 *   - Přímé DB side-effects, edge function calls
 *   - Routing do Hanička/Káťa rooms (řeší KarelOverviewPanel a detail)
 *
 * VIZUÁL:
 *   - Tlumený warm tint (žádná tvrdá červená přes celý vršek)
 *   - Severity rozlišena pouze jemným akcentem na levém border + badge barvou
 *   - Kompaktní 1-řádkový layout (ikona + identita + badges + chevron)
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

// ── Severity → kultivovaný HSL tint (žádná křiklavá červená) ──
//   Zdroj: design system semantic tokens; inline RGBA jen jako fallback,
//   protože banner je sticky nad Pracovnou a potřebuje vlastní subtle pozadí.
const severityTint = (severity: string) => {
  switch (severity?.toLowerCase()) {
    case "critical":
      // tlumený rose/wine — varuje, ale neřve
      return { bg: "hsl(8 35% 96%)", border: "hsl(8 45% 78%)", accent: "hsl(8 55% 45%)" };
    case "high":
    case "elevated":
      // teplý terracotta
      return { bg: "hsl(20 40% 96%)", border: "hsl(20 50% 80%)", accent: "hsl(20 60% 42%)" };
    case "moderate":
      // sand / ochre
      return { bg: "hsl(38 40% 96%)", border: "hsl(38 45% 80%)", accent: "hsl(38 55% 38%)" };
    default:
      // low / unknown — neutral stone
      return { bg: "hsl(34 22% 95%)", border: "hsl(34 18% 82%)", accent: "hsl(34 25% 38%)" };
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
            backgroundColor: "hsl(8 25% 92%)",
            color: "hsl(8 45% 30%)",
            borderBottom: "1px solid hsl(8 25% 82%)",
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
        const tint = severityTint(card.severity);

        return (
          <div key={id}>
            {/* ── Banner row (signalizační, 1 řádek, kultivovaný tint) ── */}
            <div
              className="px-4 py-2 transition-colors"
              style={{
                backgroundColor: tint.bg,
                borderBottom: `1px solid ${tint.border}`,
                borderLeft: `3px solid ${tint.accent}`,
              }}
            >
              <div className="max-w-[900px] mx-auto flex items-center gap-2 text-[13px] flex-wrap">
                <Shield className="w-4 h-4 shrink-0" style={{ color: tint.accent }} />
                <span className="font-semibold" style={{ color: tint.accent }}>
                  {card.displayName}
                </span>

                {/* severity (display-only) */}
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    backgroundColor: tint.accent,
                    color: "white",
                    opacity: 0.85,
                  }}
                >
                  {card.severity}
                </span>

                {/* operating state (display-only badge) */}
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: "hsl(0 0% 100% / 0.7)",
                    color: tint.accent,
                    border: `1px solid ${tint.border}`,
                  }}
                >
                  {stateLabel}
                </span>

                {/* den krize (display-only) */}
                {card.daysActive != null && (
                  <span className="text-[11px]" style={{ color: tint.accent, opacity: 0.7 }}>
                    den {card.daysActive}
                  </span>
                )}

                {/* primary therapist (display-only) */}
                {card.primaryTherapist && card.primaryTherapist !== "neurčeno" && (
                  <span
                    className="text-[10px] flex items-center gap-1"
                    style={{ color: tint.accent, opacity: 0.75 }}
                  >
                    <Users className="w-3 h-3" />
                    {card.primaryTherapist}
                  </span>
                )}

                {/* hours stale (display-only, jen když relevantní) */}
                {card.isStale && (
                  <span
                    className="text-[10px] flex items-center gap-1"
                    style={{ color: tint.accent, opacity: 0.75 }}
                  >
                    <Clock className="w-3 h-3" />
                    {Math.round(card.hoursStale)}h bez kontaktu
                  </span>
                )}

                {/* ── 1–2 statusové deficitní badges (display-only, ne CTA) ── */}
                {card.missingTodayInterview && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: "hsl(38 50% 90%)",
                      color: "hsl(38 60% 30%)",
                    }}
                  >
                    chybí: dnešní hodnocení
                  </span>
                )}
                {card.missingTherapistFeedback && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: "hsl(38 50% 90%)",
                      color: "hsl(38 60% 30%)",
                    }}
                  >
                    chybí: feedback
                  </span>
                )}

                {/* ── Jediný vstup: Otevřít detail ── */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : id)}
                  className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors hover:bg-white/40"
                  style={{ color: tint.accent }}
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
