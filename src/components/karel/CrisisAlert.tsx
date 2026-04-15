import React, { useState } from "react";
import { Shield, ChevronDown, ChevronUp, AlertTriangle, Users, Bell } from "lucide-react";
import { useCrisisOperationalState, type CrisisOperationalCard, type CrisisCTA } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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

async function callEdgeFn(fnName: string, body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

const CrisisAlert: React.FC = () => {
  const { cards, loading, refetch, globalUnreadBriefCount } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<"management" | "closure" | "history" | "audit" | undefined>(undefined);
  const [ctaLoading, setCtaLoading] = useState<string | null>(null);

  if (loading || cards.length === 0) return null;

  const handleCTAClick = async (cardId: string, cta: CrisisCTA, card: CrisisOperationalCard) => {
    const targetTab = CTA_ACTION_TO_TAB[cta.action] || "management";

    // Wire specific CTAs to backend functions
    if (cta.action === "request_update" && card.eventId) {
      setCtaLoading(cta.key);
      try {
        await callEdgeFn("karel-crisis-daily-assessment", {
          crisis_event_id: card.eventId,
          crisis_alert_id: card.alertId,
          part_name: card.partName,
        });
        toast.success("Denní hodnocení spuštěno");
        refetch();
      } catch {
        toast.error("Spuštění hodnocení selhalo");
      } finally {
        setCtaLoading(null);
      }
    }

    if (cta.action === "start_interview" && card.eventId) {
      setCtaLoading(cta.key);
      try {
        await callEdgeFn("karel-crisis-interview", {
          action: "start",
          crisis_event_id: card.eventId,
          part_name: card.partName,
          interview_type: "diagnostic",
        });
        toast.success("Krizový rozhovor zahájen");
        refetch();
      } catch {
        toast.error("Zahájení rozhovoru selhalo");
      } finally {
        setCtaLoading(null);
      }
    }

    setInitialTab(targetTab);
    setExpandedId(cardId);
  };

  const handleMissingClick = (cardId: string, flag: string, card: CrisisOperationalCard) => {
    if (flag === "interview") {
      // Open management tab — interview section
      handleCTAClick(cardId, { key: "start_interview", label: "Interview", action: "start_interview", priority: "high" }, card);
    } else if (flag === "feedback") {
      // Open management tab — Q/A section
      setInitialTab("management");
      setExpandedId(cardId);
    }
  };

  return (
    <div className="sticky top-0 z-50">
      {/* Global brief indicator */}
      {globalUnreadBriefCount > 0 && (
        <div className="text-white px-4 py-1 flex items-center justify-center gap-1 text-[11px]" style={{ backgroundColor: "#5C1A1A" }}>
          <Bell className="w-3 h-3" />
          {globalUnreadBriefCount} nepřečtený brief{globalUnreadBriefCount > 1 ? "y" : ""} (celkem)
        </div>
      )}

      {cards.map(card => {
        const id = card.eventId || card.alertId || card.partName;
        const isExpanded = expandedId === id;
        const stateLabel = card.operatingState ? STATE_LABELS[card.operatingState] || card.operatingState : "aktivní";

        const bannerCTAs = card.computedCTAs.slice(0, 2);

        const hasMeeting = card.meetingOpen || (card.closureMeeting && card.closureMeeting.status !== "finalized");
        const meetingLabel = card.closureMeeting ? "closure meeting" : card.meetingOpen ? "porada" : card.crisisMeetingRequired ? "⚠ porada doporučena" : null;

        return (
          <div key={id}>
            <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="max-w-[900px] mx-auto">
                {/* ── Top row: identity + status ── */}
                <div className="flex items-center gap-2 text-[13px] flex-wrap">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="font-bold">{card.displayName}</span>
                  <span className="text-white/70 text-[11px]">{card.severity}</span>
                  <span className="bg-white/15 text-[10px] px-1.5 py-0.5 rounded font-medium">{stateLabel}</span>
                  {card.daysActive && <span className="text-white/60 text-[11px]">den {card.daysActive}</span>}

                  {/* Clickable missing flags */}
                  {card.missingTodayInterview && (
                    <button
                      onClick={() => handleMissingClick(id, "interview", card)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      chybí: interview
                    </button>
                  )}
                  {card.missingTherapistFeedback && (
                    <button
                      onClick={() => handleMissingClick(id, "feedback", card)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      chybí: feedback
                    </button>
                  )}
                  {card.unansweredQuestionCount > 0 && (
                    <button
                      onClick={() => handleMissingClick(id, "feedback", card)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      {card.unansweredQuestionCount} Q
                    </button>
                  )}

                  {meetingLabel && (
                    <span className="text-[10px] bg-blue-500/30 text-blue-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {meetingLabel}
                    </span>
                  )}

                  <button
                    onClick={() => { setInitialTab(undefined); setExpandedId(isExpanded ? null : id); }}
                    className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors shrink-0 ml-auto"
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* ── Second row: blocker + contact times + CTAs ── */}
                {!isExpanded && (
                  <div className="flex items-center gap-2 mt-1 text-[11px] text-white/80 flex-wrap">
                    {card.mainBlocker && (
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-yellow-300 shrink-0" />
                        {card.mainBlocker}
                      </span>
                    )}

                    {/* Plain text contact freshness — deduplicated, no badge */}
                    {card.isStale && (
                      <span className="text-[10px] text-white/50">
                        {Math.round(card.hoursStale)}h bez kontaktu s částí
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
                            onClick={() => handleCTAClick(id, cta, card)}
                            disabled={ctaLoading === cta.key}
                            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                              ctaLoading === cta.key ? "opacity-50 cursor-wait" :
                              cta.priority === "critical" ? "bg-red-500/40 hover:bg-red-500/60 text-white font-bold"
                              : cta.priority === "high" ? "bg-amber-500/30 hover:bg-amber-500/50 text-yellow-100"
                              : "bg-white/15 hover:bg-white/25 text-white/90"
                            }`}
                          >
                            {ctaLoading === cta.key ? "…" : cta.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

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
