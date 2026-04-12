import React, { useState } from "react";
import {
  Activity, CheckCircle, AlertTriangle, Clock, Users, HelpCircle, Target,
  Zap, ShieldAlert, CalendarCheck, MessageSquareDashed, Brain, ArrowRight, RefreshCw, Loader2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import { ALLOWED_TRANSITIONS, STATE_TRANSITION_LABELS } from "@/hooks/useCrisisOperationalState";
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

// ── Backend call helpers ────────────────────────────────────────

async function callClosureMeetingApi(action: string, body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/karel-crisis-closure-meeting`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ action, ...body }),
  });
  return res.json();
}

async function callDailyCycleApi(body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/karel-did-daily-cycle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ═════════════════════════════════════════════════════════════════

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch }) => {
  const [activeTab, setActiveTab] = useState<"detail" | "history">("detail");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [positionInput, setPositionInput] = useState<{ therapist: string; text: string } | null>(null);

  const trend = TREND_LABELS[card.trend48h] || TREND_LABELS.unknown;
  const riskClass = RISK_COLORS[card.lastAssessmentRisk || ""] || "bg-muted text-foreground";

  // ── Action wrappers ──────────────────────────────────────────

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setActionLoading(key);
    try { await fn(); } finally { setActionLoading(null); }
  };

  const handleTransitionState = async (targetState: string) => {
    if (!card.eventId) return;
    await withLoading(`transition_${targetState}`, async () => {
      const data = await callClosureMeetingApi("transition_state", {
        crisis_event_id: card.eventId,
        target_state: targetState,
        reason: "manuální přechod z UI",
      });
      if (data.success) {
        toast.success(`Stav změněn: ${STATE_LABELS[targetState] || targetState}`);
        onRefetch();
      } else {
        toast.error(data.error || "Přechod zamítnut", {
          description: data.blockers?.join(", "),
        });
      }
    });
  };

  const handleInitiateClosureMeeting = async () => {
    if (!card.eventId) return;
    await withLoading("initiate_closure", async () => {
      const data = await callClosureMeetingApi("initiate_closure_meeting", {
        crisis_event_id: card.eventId,
        reason: "Manuální svolání z UI",
      });
      if (data.success) {
        toast.success(data.already_exists ? "Closure meeting už existuje" : "Closure meeting založen");
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleSubmitPosition = async (therapist: string, position: string) => {
    if (!card.closureMeeting) return;
    await withLoading(`position_${therapist}`, async () => {
      const data = await callClosureMeetingApi("submit_position", {
        meeting_id: card.closureMeeting!.meetingId,
        therapist,
        position,
      });
      if (data.success) {
        toast.success(`Stanovisko ${therapist === "hanka" ? "Hanky" : "Káti"} uloženo`);
        setPositionInput(null);
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleGenerateKarelStatement = async () => {
    if (!card.eventId) return;
    await withLoading("karel_statement", async () => {
      const data = await callClosureMeetingApi("generate_karel_statement", {
        crisis_event_id: card.eventId,
      });
      if (data.success) {
        toast.success("Karlův finální statement vygenerován");
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleCheckReadiness = async () => {
    if (!card.eventId) return;
    await withLoading("check_readiness", async () => {
      const data = await callClosureMeetingApi("check_closure_readiness", {
        crisis_event_id: card.eventId,
      });
      if (data.readiness) {
        toast.info(data.readiness.overall_ready ? "✅ Všechny 4 vrstvy splněny" : `❌ Blockery: ${data.readiness.all_blockers.length}`);
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleApproveClosure = async () => {
    if (!card.eventId) return;
    await withLoading("approve_closure", async () => {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const session = (await supabase.auth.getSession()).data.session;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/approve-crisis-closure`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ crisis_event_id: card.eventId }),
      });
      const data = await res.json();
      if (data.success || data.closed) {
        toast.success("Krize uzavřena");
        onRefetch();
      } else {
        toast.error(data.error || "Uzavření zamítnuto", {
          description: data.blockers?.join(", "),
        });
      }
    });
  };

  const handleRefreshDailyCycle = async () => {
    if (!card.eventId) return;
    await withLoading("refresh_daily", async () => {
      const data = await callDailyCycleApi({
        crisis_event_id: card.eventId,
        part_name: card.partName,
      });
      if (data.error) toast.error(data.error);
      else { toast.success("Denní cyklus aktualizován"); onRefetch(); }
    });
  };

  const handleMarkEveningDecision = async () => {
    if (!card.eventId) return;
    await withLoading("evening_decision", async () => {
      await supabase.from("crisis_events").update({
        last_evening_decision_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", card.eventId);
      toast.success("Evening decision označen");
      onRefetch();
    });
  };

  const handleAcknowledge = async () => {
    if (!card.alertId) return;
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase.from("crisis_alerts").update({
      status: "ACKNOWLEDGED", acknowledged_by: userName, acknowledged_at: new Date().toISOString(),
    }).eq("id", card.alertId);
    onRefetch();
  };

  // ── Derived data ──────────────────────────────────────────────

  const todayStr = new Date().toISOString().slice(0, 10);
  const isPhaseToday = (d: string | null) => d ? d.slice(0, 10) === todayStr : false;
  const dailyCyclePhases = [
    { label: "Ráno", done: isPhaseToday(card.lastMorningReviewAt), at: card.lastMorningReviewAt },
    { label: "Odpoledne", done: isPhaseToday(card.lastAfternoonReviewAt), at: card.lastAfternoonReviewAt },
    { label: "Po sezení", done: isPhaseToday(card.lastOutcomeRecordedAt), at: card.lastOutcomeRecordedAt },
    { label: "Večer", done: isPhaseToday(card.lastEveningDecisionAt), at: card.lastEveningDecisionAt },
  ];

  // State machine: allowed transitions from current state
  const currentState = card.operatingState || "active";
  const allowedTransitions = (ALLOWED_TRANSITIONS[currentState] || []).filter(s => {
    // Hide "closed" from direct state machine — use closure workflow instead
    if (s === "closed") return false;
    return true;
  });

  // Backend readiness (authoritative) vs local fallback
  const r4 = card.closureReadiness4Layer;
  const hasBackendReadiness = r4 != null;

  // Local fallback readiness
  const cl = card.closureChecklistState;
  const localClinicalBlockers: string[] = [];
  if (!cl.noRiskSignals) localClinicalBlockers.push("Rizikové signály");
  if (!cl.triggerManaged) localClinicalBlockers.push("Trigger nezvládnut");
  if (cl.emotionalStableDays < 2) localClinicalBlockers.push(`Stabilita ${cl.emotionalStableDays}/2 dní`);
  const localProcessBlockers: string[] = [];
  if (!cl.karelDiagnosticDone) localProcessBlockers.push("Diagnostické sezení");
  if (!cl.noOpenQuestions) localProcessBlockers.push("Otevřené otázky");
  if (card.unansweredQuestionCount > 0) localProcessBlockers.push(`${card.unansweredQuestionCount} nezodpovězených Q`);
  const localTeamBlockers: string[] = [];
  if (!card.closureMeeting) localTeamBlockers.push("Closure meeting nezaložen");
  else {
    if (!card.closureMeeting.hankaPosition) localTeamBlockers.push("Stanovisko Hanky");
    if (!card.closureMeeting.kataPosition) localTeamBlockers.push("Stanovisko Káti");
    if (!card.closureMeeting.karelFinalStatement) localTeamBlockers.push("Karlův statement");
    if (!card.closureMeeting.closureRecommendation) localTeamBlockers.push("Closure recommendation");
  }
  if (!cl.hankaAgrees) localTeamBlockers.push("Souhlas Hanky");
  if (!cl.kataAgrees) localTeamBlockers.push("Souhlas Káti");
  const localOperationalBlockers: string[] = [];
  if (!cl.relapsePlanExists) localOperationalBlockers.push("Relapse plán");
  if (!cl.groundingWorks) localOperationalBlockers.push("Grounding nefunguje");

  const readinessLayers = hasBackendReadiness ? [
    { label: "Klinická", blockers: r4!.clinical.blockers, met: r4!.clinical.met },
    { label: "Procesní", blockers: r4!.process.blockers, met: r4!.process.met },
    { label: "Týmová", blockers: r4!.team.blockers, met: r4!.team.met },
    { label: "Operační", blockers: r4!.operational.blockers, met: r4!.operational.met },
  ] : [
    { label: "Klinická", blockers: localClinicalBlockers, met: localClinicalBlockers.length === 0 },
    { label: "Procesní", blockers: localProcessBlockers, met: localProcessBlockers.length === 0 },
    { label: "Týmová", blockers: localTeamBlockers, met: localTeamBlockers.length === 0 },
    { label: "Operační", blockers: localOperationalBlockers, met: localOperationalBlockers.length === 0 },
  ];

  const readinessMet = readinessLayers.filter(l => l.met).length;
  const readinessPercent = Math.round((readinessMet / 4) * 100);
  const overallReady = hasBackendReadiness ? r4!.overallReady : readinessLayers.every(l => l.met);

  const ActionBtn: React.FC<{ loadingKey: string; onClick: () => void; children: React.ReactNode; variant?: string }> = ({ loadingKey, onClick, children, variant }) => {
    const isLoading = actionLoading === loadingKey;
    const base = variant === "danger"
      ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
      : variant === "success"
      ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50"
      : "bg-primary/10 text-primary hover:bg-primary/20";
    return (
      <button
        onClick={onClick}
        disabled={isLoading || actionLoading != null}
        className={`text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 ${base}`}
      >
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        {children}
      </button>
    );
  };

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* ── Tab bar ── */}
      <div className="flex border-b text-xs">
        <button onClick={() => setActiveTab("detail")} className={`flex-1 py-2 font-medium transition-colors ${activeTab === "detail" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}>
          Řízení
        </button>
        <button onClick={() => setActiveTab("history")} className={`flex-1 py-2 font-medium transition-colors ${activeTab === "history" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}>
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
              { label: "Operating State", value: STATE_LABELS[currentState] || currentState },
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

          {/* ══ STATE MACHINE ACTIONS ══ */}
          {allowedTransitions.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-2">
              <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <ArrowRight className="w-3.5 h-3.5" />
                Přechod stavu
              </p>
              <div className="flex flex-wrap gap-1.5">
                {allowedTransitions.map(ts => (
                  <ActionBtn key={ts} loadingKey={`transition_${ts}`} onClick={() => handleTransitionState(ts)}>
                    {STATE_TRANSITION_LABELS[ts] || ts}
                  </ActionBtn>
                ))}
              </div>
            </div>
          )}

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
                    {latest.summaryForTeam && <p className="text-xs text-foreground max-h-24 overflow-y-auto whitespace-pre-wrap">{latest.summaryForTeam}</p>}
                    {latest.karelDecision && <p className="text-[11px] text-blue-700 dark:text-blue-400"><strong>Rozhodnutí:</strong> {latest.karelDecision}</p>}
                    {latest.whatRemains && <p className="text-[11px] text-muted-foreground italic">Zůstává nejasné: {latest.whatRemains}</p>}
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

          {/* ── Daily cycle (4 phases) + actions ── */}
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
            <div className="flex gap-1.5 mt-2">
              <ActionBtn loadingKey="refresh_daily" onClick={handleRefreshDailyCycle}>
                <RefreshCw className="w-3 h-3" /> Refresh cyklus
              </ActionBtn>
              {!isPhaseToday(card.lastEveningDecisionAt) && (
                <ActionBtn loadingKey="evening_decision" onClick={handleMarkEveningDecision}>
                  Označit evening decision
                </ActionBtn>
              )}
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

          {/* ══ CLOSURE WORKFLOW ══ */}
          <div className="bg-muted/30 rounded-lg p-3 space-y-2">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              {card.closureMeeting ? "Closure Meeting" : "Krizová porada"}
            </p>

            {card.closureMeeting ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-foreground">Stav: <strong>{card.closureMeeting.status}</strong></span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  {[
                    { key: "hanka", label: "Hanka", value: card.closureMeeting.hankaPosition },
                    { key: "kata", label: "Káťa", value: card.closureMeeting.kataPosition },
                    { key: "karel", label: "Karel", value: card.closureMeeting.karelFinalStatement },
                    { key: "rec", label: "Doporučení", value: card.closureMeeting.closureRecommendation },
                  ].map(item => (
                    <div key={item.key} className="flex items-center gap-1">
                      {item.value ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                      <span>{item.label}: {item.value ? "✓" : "čeká"}</span>
                    </div>
                  ))}
                </div>

                {/* Recorded positions */}
                {card.closureMeeting.hankaPosition && (
                  <p className="text-[10px] text-muted-foreground"><strong>Hanka:</strong> {card.closureMeeting.hankaPosition.slice(0, 150)}</p>
                )}
                {card.closureMeeting.kataPosition && (
                  <p className="text-[10px] text-muted-foreground"><strong>Káťa:</strong> {card.closureMeeting.kataPosition.slice(0, 150)}</p>
                )}
                {card.closureMeeting.karelFinalStatement && (
                  <div className="bg-blue-50 dark:bg-blue-950/20 rounded p-2 text-[10px] text-blue-800 dark:text-blue-300 max-h-20 overflow-y-auto whitespace-pre-wrap">
                    <strong>Karel:</strong> {card.closureMeeting.karelFinalStatement.slice(0, 300)}
                  </div>
                )}

                {/* Closure workflow actions */}
                <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/50">
                  {!card.closureMeeting.hankaPosition && (
                    positionInput?.therapist === "hanka" ? (
                      <div className="flex gap-1 w-full">
                        <input
                          className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground"
                          placeholder="Stanovisko Hanky…"
                          value={positionInput.text}
                          onChange={e => setPositionInput({ therapist: "hanka", text: e.target.value })}
                        />
                        <ActionBtn loadingKey="position_hanka" onClick={() => handleSubmitPosition("hanka", positionInput.text)}>
                          Uložit
                        </ActionBtn>
                      </div>
                    ) : (
                      <ActionBtn loadingKey="position_hanka" onClick={() => setPositionInput({ therapist: "hanka", text: "" })}>
                        Zapsat stanovisko Hanky
                      </ActionBtn>
                    )
                  )}
                  {!card.closureMeeting.kataPosition && (
                    positionInput?.therapist === "kata" ? (
                      <div className="flex gap-1 w-full">
                        <input
                          className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground"
                          placeholder="Stanovisko Káti…"
                          value={positionInput.text}
                          onChange={e => setPositionInput({ therapist: "kata", text: e.target.value })}
                        />
                        <ActionBtn loadingKey="position_kata" onClick={() => handleSubmitPosition("kata", positionInput.text)}>
                          Uložit
                        </ActionBtn>
                      </div>
                    ) : (
                      <ActionBtn loadingKey="position_kata" onClick={() => setPositionInput({ therapist: "kata", text: "" })}>
                        Zapsat stanovisko Káti
                      </ActionBtn>
                    )
                  )}
                  {!card.closureMeeting.karelFinalStatement && (
                    <ActionBtn loadingKey="karel_statement" onClick={handleGenerateKarelStatement}>
                      <Brain className="w-3 h-3" /> Vygenerovat Karlův statement
                    </ActionBtn>
                  )}
                </div>
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
                <ActionBtn loadingKey="initiate_closure" onClick={handleInitiateClosureMeeting}>
                  Otevřít krizovou poradu
                </ActionBtn>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Není potřeba</p>
                {card.eventId && (
                  <ActionBtn loadingKey="initiate_closure" onClick={handleInitiateClosureMeeting}>
                    <Users className="w-3 h-3" /> Svolat closure meeting
                  </ActionBtn>
                )}
              </div>
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
              Připravenost k uzavření ({readinessPercent}%)
              {!hasBackendReadiness && (
                <span className="text-[9px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-1.5 rounded ml-1">
                  lokální odhad
                </span>
              )}
              {hasBackendReadiness && (
                <span className="text-[9px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">
                  backend ✓
                </span>
              )}
            </h4>
            <Progress value={readinessPercent} className="h-2 mb-3" />

            <div className="space-y-2">
              {readinessLayers.map((layer, i) => (
                <div key={i} className="text-[11px]">
                  <div className="flex items-center gap-1.5">
                    {layer.met ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                    <span className={layer.met ? "text-muted-foreground" : "text-foreground font-medium"}>{layer.label}</span>
                    {!layer.met && <span className="text-muted-foreground">— {layer.blockers.join(", ")}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-1.5 mt-2">
              <ActionBtn loadingKey="check_readiness" onClick={handleCheckReadiness}>
                <RefreshCw className="w-3 h-3" /> Zkontrolovat readiness
              </ActionBtn>
              {overallReady && (
                <ActionBtn loadingKey="approve_closure" onClick={handleApproveClosure} variant="success">
                  <CheckCircle className="w-3 h-3" /> Uzavřít krizi
                </ActionBtn>
              )}
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
                  <div key={t.id} className="flex items-start gap-2 text-[11px]">
                    <div>
                      <p className="text-xs font-medium text-foreground">{t.title}</p>
                      <p className="text-[10px] text-muted-foreground">{t.assignedTo} · {t.priority}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Future slots (prepared but not active) ── */}
          <div className="text-[10px] text-muted-foreground/60 pt-2 border-t border-border/30 space-y-0.5">
            <p>🔲 Therapist crisis profiling — připraveno</p>
            <p>🔲 Part card propagation status — připraveno</p>
            <p>🔲 05A sync status — připraveno</p>
          </div>

          {/* ── Bottom actions ── */}
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {card.alertId && (
              <ActionBtn loadingKey="acknowledge" onClick={handleAcknowledge}>
                <CheckCircle className="w-3 h-3" /> Vzít na vědomí
              </ActionBtn>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CrisisOperationalDetail;
