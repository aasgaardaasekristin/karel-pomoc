import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp, AlertTriangle, Users, Bell } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard, type CrisisCTA } from "@/hooks/useCrisisOperationalState";
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

/** Map CTA action → target tab in CrisisOperationalDetail */
const CTA_ACTION_TO_TAB: Record<string, "management" | "closure" | "audit"> = {
  request_update: "management",
  start_interview: "management",
  record_session_result: "management",
  request_feedback: "management",
  answer_questions: "management",
  open_meeting: "closure",
  prepare_closure: "closure",
};

const CrisisAlert: React.FC = () => {
  const { cards, loading, refetch, globalUnreadBriefCount } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<"management" | "closure" | "history" | "audit" | undefined>(undefined);

  if (loading || cards.length === 0) return null;

  const handleCTAClick = (cardId: string, cta: CrisisCTA) => {
    const targetTab = CTA_ACTION_TO_TAB[cta.action] || "management";
    setInitialTab(targetTab);
    setExpandedId(cardId);
  };

  return (
    <div className="sticky top-0 z-50">
      {cards.map(card => {
        const id = card.eventId || card.alertId || card.partName;
        const isExpanded = expandedId === id;
        const stateLabel = card.operatingState ? STATE_LABELS[card.operatingState] || card.operatingState : "aktivní";

        // Max 2 CTAs with highest priority for banner
        const bannerCTAs = card.computedCTAs.slice(0, 2);

        // Missing indicators (compact)
        const missingFlags: string[] = [];
        if (card.missingTodayInterview) missingFlags.push("interview");
        if (card.missingSessionResult) missingFlags.push("sezení");
        if (card.missingTherapistFeedback) missingFlags.push("feedback");
        if (card.unansweredQuestionCount > 0) missingFlags.push(`${card.unansweredQuestionCount} Q`);

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

                  {missingFlags.length > 0 && (
                    <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      chybí: {missingFlags.join(", ")}
                    </span>
                  )}

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

                  {/* Global unread brief indicator (crisis_briefs has no per-event FK) */}
                  {globalUnreadBriefCount > 0 && (
                    <span className="text-[10px] bg-red-500/30 text-red-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Bell className="w-3 h-3" />
                      {globalUnreadBriefCount} brief{globalUnreadBriefCount > 1 ? "y" : ""} (celkem)
                    </span>
                  )}

                  <button
                    onClick={() => { setInitialTab(undefined); setExpandedId(isExpanded ? null : id); }}
                    className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors shrink-0 ml-auto"
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* Row 2: Main blocker + closure blocker + CTA */}
                {!isExpanded && (
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-white/80 flex-wrap">
                    {card.mainBlocker && (
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-yellow-300 shrink-0" />
                        {card.mainBlocker}
                      </span>
                    )}
                    {card.closureBlockerSummary && card.closureBlockerSummary !== card.mainBlocker && (
                      <span className="text-[10px] text-white/60">· uzavření: {card.closureBlockerSummary}</span>
                    )}
                    {bannerCTAs.length > 0 && (
                      <div className="flex gap-1.5 ml-auto">
                        {bannerCTAs.map(cta => (
                          <button
                            key={cta.key}
                            onClick={() => handleCTAClick(id, cta)}
                            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                              cta.priority === "critical" ? "bg-red-500/40 hover:bg-red-500/60 text-white font-bold"
                              : cta.priority === "high" ? "bg-amber-500/30 hover:bg-amber-500/50 text-yellow-100"
                              : "bg-white/15 hover:bg-white/25 text-white/90"
                            }`}
                          >
                            {cta.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Detail ── */}
            {isExpanded && (
              <CrisisOperationalDetail card={card} onRefetch={refetch} initialTab={initialTab} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CrisisAlert;
