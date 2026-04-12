import React, { useState } from "react";
import {
  Activity, CheckCircle, AlertTriangle, Clock, Users, HelpCircle, Target,
  Zap, ShieldAlert, CalendarCheck, MessageSquareDashed, Brain,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisHistoryTimeline from "./CrisisHistoryTimeline";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

const STATE_LABELS: Record<string, string> = {
  active: "Aktivní",
  intervened: "Po zásahu",
  stabilizing: "Stabilizace",
  awaiting_session_result: "Čeká výsledek sezení",
  awaiting_therapist_feedback: "Čeká feedback terapeutek",
  ready_for_joint_review: "K poradě",
  ready_to_close: "K uzavření",
  closed: "Uzavřeno",
  monitoring_post: "Monitoring",
};

const RISK_COLORS: Record<string, string> = {
  critical: "bg-destructive text-destructive-foreground",
  high: "bg-amber-600 text-white",
  moderate: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  minimal: "bg-green-500 text-white",
};

const TREND_LABELS: Record<string, { emoji: string; label: string }> = {
  improving: { emoji: "📈", label: "Zlepšuje se" },
  stable: { emoji: "➡️", label: "Stabilní" },
  worsening: { emoji: "📉", label: "Zhoršuje se" },
  unknown: { emoji: "❓", label: "Bez dat" },
};

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch }) => {
  const [activeTab, setActiveTab] = useState<"detail" | "history">("detail");
  const [activeTab, setActiveTab] = useState<"detail" | "history">("detail");
  const trend = TREND_LABELS[card.trend48h] || TREND_LABELS.unknown;
  const riskClass = RISK_COLORS[card.lastAssessmentRisk || ""] || "bg-muted text-foreground";

  const handleAcknowledge = async () => {
    if (!card.alertId) return;
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase.from("crisis_alerts").update({
      status: "ACKNOWLEDGED", acknowledged_by: userName, acknowledged_at: new Date().toISOString(),
    }).eq("id", card.alertId);
    onRefetch();
  };

  const handleProposeClosure = async () => {
    if (!card.alertId) return;
    try {
      await supabase.from("crisis_closure_checklist").upsert({
        crisis_alert_id: card.alertId, crisis_event_id: card.eventId,
        karel_recommends_closure: true,
        karel_closure_recommendation: "Karel navrhuje uzavření krize — klinická kritéria splněna",
      } as any, { onConflict: "crisis_alert_id" });
      toast.success("Návrh na uzavření odeslán");
      onRefetch();
    } catch { toast.error("Nepodařilo se odeslat návrh"); }
  };

  const handleToggleTask = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === "DONE" ? "PENDING" : "DONE";
    await supabase.from("crisis_tasks").update({
      status: newStatus, completed_at: newStatus === "DONE" ? new Date().toISOString() : null,
    }).eq("id", taskId);
    onRefetch();
  };

  const handleInitiateClosureMeeting = async () => {
    if (!card.eventId) return;
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/karel-crisis-closure-meeting`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        body: JSON.stringify({ action: "initiate_closure_meeting", crisis_event_id: card.eventId, reason: "Manuální svolání porady" }),
      });
      const data = await res.json();
      if (data.success) { toast.success(data.already_exists ? "Closure meeting už existuje" : "Closure meeting založen"); onRefetch(); }
      else toast.error(data.error || "Chyba");
    } catch (e) { toast.error(String(e)); }
  };

  // Daily cycle phases
  const todayStr = new Date().toISOString().slice(0, 10);
  const isPhaseToday = (d: string | null) => d ? d.slice(0, 10) === todayStr : false;
  const dailyCyclePhases = [
    { label: "Ráno", done: isPhaseToday(card.lastMorningReviewAt), at: card.lastMorningReviewAt },
    { label: "Odpoledne", done: isPhaseToday(card.lastAfternoonReviewAt), at: card.lastAfternoonReviewAt },
    { label: "Po sezení", done: isPhaseToday(card.lastOutcomeRecordedAt), at: card.lastOutcomeRecordedAt },
    { label: "Večer", done: isPhaseToday(card.lastEveningDecisionAt), at: card.lastEveningDecisionAt },
  ];

  // Closure readiness items (simplified from checklist)
  const cl = card.closureChecklistState;
  const closurePercent = Math.round(card.closureReadiness * 100);

  // Build 4-layer readiness from available data
  const clinicalBlockers: string[] = [];
  if (!cl.noRiskSignals) clinicalBlockers.push("Rizikové signály");
  if (!cl.triggerManaged) clinicalBlockers.push("Trigger nezvládnut");
  if (cl.emotionalStableDays < 2) clinicalBlockers.push(`Stabilita ${cl.emotionalStableDays}/2 dní`);

  const processBlockers: string[] = [];
  if (!cl.karelDiagnosticDone) processBlockers.push("Diagnostické sezení");
  if (!cl.noOpenQuestions) processBlockers.push("Otevřené otázky");
  if (card.unansweredQuestionCount > 0) processBlockers.push(`${card.unansweredQuestionCount} nezodpovězených Q`);

  const teamBlockers: string[] = [];
  if (!card.closureMeeting) teamBlockers.push("Closure meeting nezaložen");
  if (card.closureMeeting && !card.closureMeeting.hankaPosition) teamBlockers.push("Stanovisko Hanky");
  if (card.closureMeeting && !card.closureMeeting.kataPosition) teamBlockers.push("Stanovisko Káti");
  if (card.closureMeeting && !card.closureMeeting.karelFinalStatement) teamBlockers.push("Karlův statement");
  if (card.closureMeeting && !card.closureMeeting.closureRecommendation) teamBlockers.push("Closure recommendation");
  if (!cl.hankaAgrees) teamBlockers.push("Souhlas Hanky");
  if (!cl.kataAgrees) teamBlockers.push("Souhlas Káti");

  const operationalBlockers: string[] = [];
  if (!cl.relapsePlanExists) operationalBlockers.push("Relapse plán");
  if (!cl.groundingWorks) operationalBlockers.push("Grounding nefunguje");

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* ── Tab bar ── */}
      <div className="flex border-b text-xs">
        <button
          onClick={() => setActiveTab("detail")}
          className={`flex-1 py-2 font-medium transition-colors ${activeTab === "detail" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          Řízení
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={`flex-1 py-2 font-medium transition-colors ${activeTab === "history" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          Historie
        </button>
      </div>

      {activeTab === "history" ? (
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          <CrisisHistoryTimeline card={card} />
        </div>
      ) : (
        <div className="p-4 space-y-4 text-sm max-h-[60vh] overflow-y-auto">

          {/* ── Status grid ── */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              { label: "Operating State", value: card.operatingState ? (STATE_LABELS[card.operatingState] || card.operatingState) : "—" },
              { label: "Den", value: card.daysActive ?? "—" },
              { label: "Riziko", value: card.lastAssessmentRisk || "—", className: riskClass },
              { label: "Trend 48h", value: `${trend.emoji} ${trend.label}` },
              { label: "Kontakt", value: card.lastContactAt ? `${Math.round(card.hoursStale)}h` : "—", alert: card.isStale },
            ].map((item, i) => (
              <div key={i} className="bg-muted/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-muted-foreground">{item.label}</p>
                <p className={`font-bold text-xs ${item.alert ? "text-destructive" : "text-foreground"} ${"className" in item ? item.className : ""}`}>
                  {String(item.value)}
                </p>
              </div>
            ))}
          </div>

          {/* ── Clinical summary ── */}
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" />
              Klinické shrnutí
            </p>
            <p className="text-xs text-foreground">{card.displaySummary}</p>
          </div>

          {/* ── Ownership ── */}
          <div className="flex items-center gap-3 text-[11px]">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-foreground font-medium">
              Vede: {card.primaryTherapist}
              {card.secondaryTherapist && ` · Podpora: ${card.secondaryTherapist}`}
            </span>
          </div>

          {/* ── Karel's latest interview ── */}
          {card.interviews.length > 0 && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-1">
              <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
                <Brain className="w-3.5 h-3.5" />
                Karlův krizový rozhovor
                {card.todayInterviewDone && <span className="text-[9px] bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">dnes ✓</span>}
              </p>
              {(() => {
                const latest = card.interviews[0];
                return (
                  <>
                    {latest.summaryForTeam && (
                      <p className="text-xs text-foreground max-h-24 overflow-y-auto whitespace-pre-wrap">{latest.summaryForTeam}</p>
                    )}
                    {latest.karelDecision && (
                      <p className="text-[11px] text-blue-700 dark:text-blue-400">
                        <strong>Rozhodnutí:</strong> {latest.karelDecision}
                      </p>
                    )}
                    {latest.whatRemains && (
                      <p className="text-[11px] text-muted-foreground italic">Zůstává nejasné: {latest.whatRemains}</p>
                    )}
                    <div className="flex gap-3 text-[10px] text-muted-foreground mt-1">
                      {latest.observedRegulation != null && <span>Regulace: {latest.observedRegulation}/10</span>}
                      {latest.observedTrust != null && <span>Důvěra: {latest.observedTrust}/10</span>}
                      {latest.observedCoherence != null && <span>Koherence: {latest.observedCoherence}/10</span>}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* ── Daily cycle (4 phases) ── */}
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <CalendarCheck className="w-3.5 h-3.5" />
              Denní cyklus
            </h4>
            <div className="grid grid-cols-4 gap-1.5">
              {dailyCyclePhases.map((ph, i) => (
                <div key={i} className={`text-center rounded-lg p-2 text-[11px] ${ph.done ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300" : "bg-muted/50 text-muted-foreground"}`}>
                  <p className="font-medium">{ph.label}</p>
                  <p className="text-[10px]">{ph.done ? "✅" : "⚠️"}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Required outputs today ── */}
          {card.todayRequiredOutputs.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" />
                Povinné výstupy dne
              </h4>
              <div className="space-y-1">
                {card.todayRequiredOutputs.map((o, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    {o.fulfilled ? <CheckCircle className="w-3 h-3 text-green-600 shrink-0" /> : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
                    <span className={o.fulfilled ? "text-muted-foreground" : "text-foreground font-medium"}>{o.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Awaiting response ── */}
          {card.awaitingResponseFrom.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <p className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <MessageSquareDashed className="w-3.5 h-3.5" />
                Čeká se na odpověď
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                {card.awaitingResponseFrom.map(n => n === "hanka" ? "Hanička" : n === "kata" ? "Káťa" : n).join(", ")}
              </p>
            </div>
          )}

          {/* ── Session Q/A status ── */}
          {card.sessionQuestions.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-1">
              <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5" />
                Post-session Q/A ({card.sessionQuestions.length - card.unansweredQuestionCount}/{card.sessionQuestions.length})
                {card.sessionQAComplete && <span className="text-[9px] bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">kompletní</span>}
              </p>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {card.sessionQuestions.slice(0, 5).map(q => (
                  <div key={q.id} className="flex items-start gap-1.5 text-[10px]">
                    {q.answeredAt ? <CheckCircle className="w-3 h-3 text-green-600 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />}
                    <div>
                      <span className="text-foreground">{q.questionText.slice(0, 80)}</span>
                      <span className="text-muted-foreground ml-1">({q.therapistName === "hanka" ? "Hanička" : "Káťa"})</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Crisis meeting / Closure meeting ── */}
          <div className="bg-muted/30 rounded-lg p-3 space-y-2">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              {card.closureMeeting ? "Closure Meeting" : "Krizová porada"}
            </p>

            {card.closureMeeting ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-foreground">Stav: <strong>{card.closureMeeting.status}</strong></span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  <div className="flex items-center gap-1">
                    {card.closureMeeting.hankaPosition ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span>Hanka: {card.closureMeeting.hankaPosition ? "stanovisko ✓" : "čeká"}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {card.closureMeeting.kataPosition ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span>Káťa: {card.closureMeeting.kataPosition ? "stanovisko ✓" : "čeká"}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {card.closureMeeting.karelFinalStatement ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span>Karel: {card.closureMeeting.karelFinalStatement ? "statement ✓" : "čeká"}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {card.closureMeeting.closureRecommendation ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span>Recommendation: {card.closureMeeting.closureRecommendation ? "✓" : "čeká"}</span>
                  </div>
                </div>
                {card.closureMeeting.hankaPosition && (
                  <p className="text-[10px] text-muted-foreground"><strong>Hanka:</strong> {card.closureMeeting.hankaPosition.slice(0, 120)}</p>
                )}
                {card.closureMeeting.kataPosition && (
                  <p className="text-[10px] text-muted-foreground"><strong>Káťa:</strong> {card.closureMeeting.kataPosition.slice(0, 120)}</p>
                )}
                {card.closureMeeting.karelFinalStatement && (
                  <div className="bg-blue-50 dark:bg-blue-950/20 rounded p-2 text-[10px] text-blue-800 dark:text-blue-300 max-h-20 overflow-y-auto whitespace-pre-wrap">
                    <strong>Karel:</strong> {card.closureMeeting.karelFinalStatement.slice(0, 300)}
                  </div>
                )}
              </div>
            ) : card.meetingOpen ? (
              <div className="space-y-0.5">
                <p className="text-xs text-foreground">✅ Otevřená{card.meetingWaitingFor && <span className="text-amber-600"> — čeká na {card.meetingWaitingFor}</span>}</p>
                {card.meetingLastConclusionAt && <p className="text-[10px] text-muted-foreground">Závěr: {new Date(card.meetingLastConclusionAt).toLocaleString("cs-CZ")}</p>}
              </div>
            ) : card.crisisMeetingRequired ? (
              <div className="space-y-1">
                <p className="text-xs text-destructive font-medium">⚠ Doporučená — zatím neotevřena</p>
                {card.crisisMeetingReason && <p className="text-[10px] text-destructive/80">{card.crisisMeetingReason}</p>}
                <button onClick={handleInitiateClosureMeeting} className="text-[10px] px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                  Otevřít krizovou poradu
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Není potřeba</p>
            )}
          </div>

          {/* ── Karel requires ── */}
          {card.karelRequires.length > 0 && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
              <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Karel vyžaduje
              </p>
              <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1 space-y-1 list-disc list-inside">
                {card.karelRequires.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {/* ── 4-Layer Closure Readiness ── */}
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" />
              Připravenost k uzavření ({closurePercent}%)
            </h4>
            <Progress value={closurePercent} className="h-2 mb-3" />

            <div className="space-y-2">
              {[
                { label: "Klinická", blockers: clinicalBlockers, met: clinicalBlockers.length === 0 },
                { label: "Procesní", blockers: processBlockers, met: processBlockers.length === 0 },
                { label: "Týmová", blockers: teamBlockers, met: teamBlockers.length === 0 },
                { label: "Operační", blockers: operationalBlockers, met: operationalBlockers.length === 0 },
              ].map((layer, i) => (
                <div key={i} className="text-[11px]">
                  <div className="flex items-center gap-1.5">
                    {layer.met ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span className={layer.met ? "text-muted-foreground" : "text-foreground font-medium"}>{layer.label}</span>
                    {!layer.met && <span className="text-muted-foreground">— {layer.blockers.join(", ")}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Open tasks ── */}
          {card.openTasks.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" /> Úkoly ({card.openTasks.length})
              </h4>
              <div className="space-y-1.5">
                {card.openTasks.map(t => (
                  <label key={t.id} className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={t.status === "DONE"} onChange={() => handleToggleTask(t.id, t.status)} className="mt-0.5 accent-destructive" />
                    <div>
                      <p className={`text-xs font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>
                      <p className="text-[10px] text-muted-foreground">{t.assignedTo} · {t.priority}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {card.alertId && (
              <button onClick={handleAcknowledge} className="text-xs px-3 py-1.5 rounded-md bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 flex items-center gap-1.5 transition-colors">
                <CheckCircle className="w-3 h-3" /> Vzít na vědomí
              </button>
            )}
            {!card.closureMeeting && card.eventId && (
              <button onClick={handleInitiateClosureMeeting} className="text-xs px-3 py-1.5 rounded-md bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200 dark:hover:bg-blue-900/50 text-blue-800 dark:text-blue-300 flex items-center gap-1.5 transition-colors">
                <Users className="w-3 h-3" /> Svolat closure meeting
              </button>
            )}
            {card.canProposeClosing && !cl.karelRecommendsClosure && (
              <button onClick={handleProposeClosure} className="text-xs px-3 py-1.5 rounded-md bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 text-green-800 dark:text-green-300 flex items-center gap-1.5 transition-colors">
                <CheckCircle className="w-3 h-3" /> Navrhnout uzavření
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CrisisOperationalDetail;
