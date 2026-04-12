import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp } from "lucide-react";
import { useCrisisOperationalState } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";

const PHASE_LABELS: Record<string, string> = {
  acute: "akutní",
  stabilizing: "stabilizace",
  diagnostic: "diagnostika",
  closing: "uzavírání",
};

const TREND_EMOJI: Record<string, string> = {
  improving: "📈",
  stable: "➡️",
  worsening: "📉",
  unknown: "",
};

const CrisisAlert: React.FC = () => {
  const { cards, loading, refetch } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading || cards.length === 0) return null;

  return (
    <div className="sticky top-0 z-50">
      {cards.map(card => {
        const id = card.eventId || card.alertId || card.partName;
        const isExpanded = expandedId === id;
        const trendEmoji = TREND_EMOJI[card.trend48h] || "";

        return (
          <div key={id}>
            {/* ── Signal-only banner ── */}
            <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="max-w-[900px] mx-auto flex items-center gap-2 text-[13px]">
                {/* Left: status indicators */}
                <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="font-bold">{card.displayName}</span>
                  <span className="text-white/70 text-[11px]">
                    {card.severity}
                  </span>
                  <span className="text-white/60 text-[11px]">
                    {card.phase ? PHASE_LABELS[card.phase] || card.phase : "aktivní"}
                    {card.daysActive ? ` · den ${card.daysActive}` : ""}
                  </span>
                  {trendEmoji && (
                    <span className="text-[11px]">{trendEmoji}</span>
                  )}
                  {card.lastAssessmentDate && (
                    <span className="text-white/50 text-[10px]">
                      záznam: {card.lastAssessmentDate}
                    </span>
                  )}
                  {card.isStale && (
                    <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded">
                      ⚠ {Math.round(card.hoursStale)}h bez kontaktu
                    </span>
                  )}
                  <span className="text-white/40 text-[10px]">
                    {card.primaryTherapist}
                  </span>
                </div>

                {/* Right: expand/collapse only */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : id)}
                  className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors shrink-0"
                  title={isExpanded ? "Skrýt detail" : "Zobrazit detail"}
                >
                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* ── Expandable operational detail ── */}
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
