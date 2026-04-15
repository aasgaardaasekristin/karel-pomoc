import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, ChevronDown, ChevronUp, AlertTriangle, Users, Bell, ExternalLink } from "lucide-react";
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
  if (!res.ok) throw new Error(`Edge function ${fnName} failed: ${res.status}`);
  return res.json();
}

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const { cards, loading, refetch, globalUnreadBriefCount } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<"management" | "closure" | "history" | "audit" | undefined>(undefined);
  const [ctaLoading, setCtaLoading] = useState<string | null>(null);

  if (loading || cards.length === 0) return null;

  // ── Deep-link: open crisis thread in DID/Kluci ──
  const navigateToCrisisThread = (partName: string, eventId: string | null) => {
    const params = new URLSearchParams();
    params.set("crisis_action", "interview");
    params.set("part_name", partName);
    if (eventId) params.set("crisis_event_id", eventId);
    // Store hub section so Chat.tsx knows we're in DID mode
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  // ── Deep-link: open feedback workspace ──
  const navigateToFeedback = (eventId: string | null) => {
    const params = new URLSearchParams();
    params.set("crisis_action", "feedback");
    if (eventId) params.set("crisis_event_id", eventId);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  // ── CTA: Spustit dnešní hodnocení (create assessment + open thread) ──
  const handleStartAssessment = async (card: CrisisOperationalCard) => {
    setCtaLoading("start_assessment");
    try {
      await callEdgeFn("karel-crisis-daily-assessment", {
        crisis_event_id: card.eventId,
        crisis_alert_id: card.alertId,
        part_name: card.partName,
      });
      toast.success("Dnešní hodnocení založeno — otevírám krizové vlákno");
      // After assessment is created, navigate to the crisis thread
      navigateToCrisisThread(card.partName, card.eventId);
    } catch (e: any) {
      toast.error(`Spuštění hodnocení selhalo: ${e.message}`);
    } finally {
      setCtaLoading(null);
    }
  };

  // ── CTA: Získat feedback terapeutek (generate questions + open workspace) ──
  const handleRequestFeedback = async (card: CrisisOperationalCard) => {
    setCtaLoading("request_feedback");
    try {
      await callEdgeFn("karel-crisis-daily-assessment", {
        crisis_event_id: card.eventId,
        crisis_alert_id: card.alertId,
        part_name: card.partName,
        generate_therapist_questions: true,
      });
      toast.success("Otázky pro terapeutky vygenerovány — otevírám feedback");
      navigateToFeedback(card.eventId);
    } catch (e: any) {
      toast.error(`Generování otázek selhalo: ${e.message}`);
    } finally {
      setCtaLoading(null);
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

        const hasMeeting = card.meetingOpen || (card.closureMeeting && card.closureMeeting.status !== "finalized");
        const meetingLabel = card.closureMeeting ? "closure meeting" : card.meetingOpen ? "porada" : card.crisisMeetingRequired ? "⚠ porada doporučena" : null;

        return (
          <div key={id}>
            <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="max-w-[900px] mx-auto">
                {/* ── Row 1: Identity + status badges ── */}
                <div className="flex items-center gap-2 text-[13px] flex-wrap">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="font-bold">{card.displayName}</span>
                  <span className="text-white/70 text-[11px]">{card.severity}</span>
                  <span className="bg-white/15 text-[10px] px-1.5 py-0.5 rounded font-medium">{stateLabel}</span>
                  {card.daysActive && <span className="text-white/60 text-[11px]">den {card.daysActive}</span>}

                  {/* ── Status links (navigational, not orchestration) ── */}
                  {card.missingTodayInterview && (
                    <button
                      onClick={() => navigateToCrisisThread(card.partName, card.eventId)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                      chybí: interview
                    </button>
                  )}
                  {card.missingTherapistFeedback && (
                    <button
                      onClick={() => navigateToFeedback(card.eventId)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                      chybí: feedback
                    </button>
                  )}
                  {card.unansweredQuestionCount > 0 && (
                    <button
                      onClick={() => navigateToFeedback(card.eventId)}
                      className="text-[10px] bg-yellow-500/30 hover:bg-yellow-500/50 text-yellow-100 px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors underline underline-offset-2"
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                      {card.unansweredQuestionCount} otázek
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

                {/* ── Row 2: Contact freshness + action CTAs ── */}
                {!isExpanded && (
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-white/70 flex-wrap">
                    {/* Plain text: hours without contact */}
                    {card.isStale && (
                      <span className="text-white/50">
                        {Math.round(card.hoursStale)}h bez kontaktu s částí
                      </span>
                    )}

                    {/* Non-duplicate blocker (only show if it's NOT the stale message) */}
                    {card.mainBlocker && (
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-yellow-300 shrink-0" />
                        {card.mainBlocker}
                      </span>
                    )}

                    {/* ── Action CTAs (orchestration, not navigation) ── */}
                    <div className="flex gap-1.5 ml-auto">
                      {/* Spustit dnešní hodnocení — creates assessment then navigates */}
                      {card.missingTodayInterview && card.eventId && (
                        <button
                          onClick={() => handleStartAssessment(card)}
                          disabled={ctaLoading === "start_assessment"}
                          className="text-[10px] px-2 py-0.5 rounded bg-amber-500/30 hover:bg-amber-500/50 text-yellow-100 transition-colors disabled:opacity-50 disabled:cursor-wait"
                        >
                          {ctaLoading === "start_assessment" ? "⏳ Zakládám…" : "▶ Spustit hodnocení"}
                        </button>
                      )}

                      {/* Získat feedback terapeutek — generates questions then navigates */}
                      {card.missingTherapistFeedback && card.eventId && (
                        <button
                          onClick={() => handleRequestFeedback(card)}
                          disabled={ctaLoading === "request_feedback"}
                          className="text-[10px] px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-white/90 transition-colors disabled:opacity-50 disabled:cursor-wait"
                        >
                          {ctaLoading === "request_feedback" ? "⏳ Generuji…" : "📋 Získat feedback"}
                        </button>
                      )}

                      {/* Meeting CTA */}
                      {card.crisisMeetingRequired && !card.meetingOpen && (
                        <button
                          onClick={() => { setInitialTab("closure"); setExpandedId(id); }}
                          className="text-[10px] px-2 py-0.5 rounded bg-blue-500/30 hover:bg-blue-500/50 text-blue-100 transition-colors"
                        >
                          🤝 Porada
                        </button>
                      )}
                    </div>
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
