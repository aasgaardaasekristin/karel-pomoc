import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp, AlertTriangle, MessageSquare, CalendarCheck, Users } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";

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

const PHASE_LABELS: Record<string, string> = {
  acute: "akutní",
  stabilizing: "stabilizace",
  diagnostic: "diagnostika",
  closing: "uzavírání",
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

        // Missing indicators
        const missingFlags: string[] = [];
        if (card.missingTodayInterview) missingFlags.push("interview");
        if (card.missingSessionResult) missingFlags.push("sezení");
        if (card.missingTherapistFeedback) missingFlags.push("feedback");
        if (card.unansweredQuestionCount > 0) missingFlags.push(`${card.unansweredQuestionCount} Q`);

        const stateLabel = card.operatingState ? STATE_LABELS[card.operatingState] || card.operatingState : (card.phase ? PHASE_LABELS[card.phase] || card.phase : "aktivní");

        const hasMeeting = card.meetingOpen || (card.closureMeeting && card.closureMeeting.status !== "finalized");
        const meetingLabel = card.closureMeeting ? "closure meeting" : card.meetingOpen ? "porada" : card.crisisMeetingRequired ? "⚠ porada doporučena" : null;

        return (
          <div key={id}>
            {/* ── Banner ── */}
            <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="max-w-[900px] mx-auto">
                {/* Row 1: Identity + status */}
                <div className="flex items-center gap-2 text-[13px] flex-wrap">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="font-bold">{card.displayName}</span>
                  <span className="text-white/70 text-[11px]">{card.severity}</span>
                  <span className="bg-white/15 text-[10px] px-1.5 py-0.5 rounded font-medium">{stateLabel}</span>
                  {card.daysActive && <span className="text-white/60 text-[11px]">den {card.daysActive}</span>}
                  <span className="text-white/40 text-[10px]">{card.primaryTherapist}</span>

                  {/* Missing flags */}
                  {missingFlags.length > 0 && (
                    <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      chybí: {missingFlags.join(", ")}
                    </span>
                  )}

                  {/* Meeting indicator */}
                  {meetingLabel && (
                    <span className="text-[10px] bg-blue-500/30 text-blue-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {meetingLabel}
                    </span>
                  )}

                  {card.isStale && (
                    <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded">
                      ⚠ {Math.round(card.hoursStale)}h bez kontaktu
                    </span>
                  )}

                  {/* Expand */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                    className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors shrink-0 ml-auto"
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* Row 2: Main blocker + CTA */}
                {card.mainBlocker && !isExpanded && (
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-white/80">
                    <AlertTriangle className="w-3 h-3 text-yellow-300 shrink-0" />
                    <span>{card.mainBlocker}</span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Detail ── */}
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
