import React, { useState } from "react";
import {
  Activity, CheckCircle, AlertTriangle, Clock, Users, HelpCircle, Target,
  CalendarCheck, MessageSquareDashed, Brain, ArrowRight, RefreshCw, Loader2,
  ChevronDown, ChevronRight, FileText, Database, Send,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard, SessionQuestion, AuditEntry } from "@/hooks/useCrisisOperationalState";
import { ALLOWED_TRANSITIONS, STATE_TRANSITION_LABELS } from "@/hooks/useCrisisOperationalState";
import CrisisHistoryTimeline from "./CrisisHistoryTimeline";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

const STATE_LABELS: Record<string, string> = {
  active: "Aktivní", intervened: "Po zásahu", stabilizing: "Stabilizace",
  awaiting_session_result: "Čeká výsledek sezení", awaiting_therapist_feedback: "Čeká feedback terapeutek",
  ready_for_joint_review: "K poradě", ready_to_close: "K uzavření",
  closed: "Uzavřeno", monitoring_post: "Monitoring",
};

const RISK_COLORS: Record<string, string> = {
  critical: "bg-destructive text-destructive-foreground", high: "bg-amber-600 text-white",
  moderate: "bg-amber-500 text-white", low: "bg-blue-500 text-white", minimal: "bg-green-500 text-white",
};

const TREND_LABELS: Record<string, { emoji: string; label: string }> = {
  improving: { emoji: "📈", label: "Zlepšuje se" }, stable: { emoji: "➡️", label: "Stabilní" },
  worsening: { emoji: "📉", label: "Zhoršuje se" }, unknown: { emoji: "❓", label: "Bez dat" },
};

const EVENING_DECISIONS = [
  { value: "continue_crisis", label: "Pokračovat v krizi", desc: "Krize trvá, bez změny stavu" },
  { value: "stabilize_and_monitor", label: "Stabilizovat a monitorovat", desc: "Přechod do stabilizace" },
  { value: "escalate", label: "Eskalovat", desc: "Návrat do aktivní krize" },
  { value: "prepare_joint_review", label: "Připravit společné review", desc: "Přechod k poradě" },
  { value: "ready_for_joint_review", label: "Připraveno k review", desc: "Přechod k uzavření" },
];

// ── Backend call helpers ────────────────────────────────────────

async function callFn(fnName: string, body: Record<string, any>) {
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

// ═════════════════════════════════════════════════════════════════

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch }) => {
  const [activeTab, setActiveTab] = useState<"detail" | "history">("detail");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [positionInput, setPositionInput] = useState<{ therapist: string; text: string } | null>(null);

  // Evening decision form state
  const [eveningForm, setEveningForm] = useState<{ open: boolean; decision: string; notes: string; nextDayPlan: string }>({
    open: false, decision: "", notes: "", nextDayPlan: "",
  });

  // Q/A answer state
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const trend = TREND_LABELS[card.trend48h] || TREND_LABELS.unknown;
  const riskClass = RISK_COLORS[card.lastAssessmentRisk || ""] || "bg-muted text-foreground";

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setActionLoading(key);
    try { await fn(); } finally { setActionLoading(null); }
  };

  // ── Actions ──────────────────────────────────────────────────

  const handleTransitionState = async (targetState: string) => {
    if (!card.eventId) return;
    await withLoading(`transition_${targetState}`, async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "transition_state", crisis_event_id: card.eventId, target_state: targetState, reason: "manuální přechod z UI" });
      if (data.success) { toast.success(`Stav změněn: ${STATE_LABELS[targetState] || targetState}`); onRefetch(); }
      else toast.error(data.error || "Přechod zamítnut", { description: data.blockers?.join(", ") });
    });
  };

  const handleSubmitEveningDecision = async () => {
    if (!card.eventId || !eveningForm.decision) return;
    await withLoading("evening_decision", async () => {
      const data = await callFn("karel-did-daily-cycle", {
        action: "submit_evening_decision",
        crisis_event_id: card.eventId,
        decision: eveningForm.decision,
        notes: eveningForm.notes || undefined,
        next_day_plan: eveningForm.nextDayPlan || undefined,
      });
      if (data.success) {
        toast.success(`Večerní rozhodnutí: ${eveningForm.decision}${data.state_changed ? ` → ${data.new_state}` : ""}`);
        setEveningForm({ open: false, decision: "", notes: "", nextDayPlan: "" });
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleSubmitQAAnswer = async (questionId: string) => {
    const answer = answerInputs[questionId];
    if (!answer?.trim()) return;
    await withLoading(`qa_${questionId}`, async () => {
      const data = await callFn("karel-crisis-session-loop", { action: "process_answer", question_id: questionId, answer_text: answer });
      if (data.success) {
        toast.success(data.analysis_triggered ? "Odpověď uložena + analýza spuštěna" : `Odpověď uložena (zbývá ${data.remaining})`);
        setAnswerInputs(prev => { const n = { ...prev }; delete n[questionId]; return n; });
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  const handleInitiateClosureMeeting = async () => {
    if (!card.eventId) return;
    await withLoading("initiate_closure", async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "initiate_closure_meeting", crisis_event_id: card.eventId, reason: "Manuální svolání z UI" });
      if (data.success) { toast.success(data.already_exists ? "Closure meeting už existuje" : "Closure meeting založen"); onRefetch(); }
      else toast.error(data.error || "Chyba");
    });
  };

  const handleSubmitPosition = async (therapist: string, position: string) => {
    if (!card.closureMeeting) return;
    await withLoading(`position_${therapist}`, async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "submit_position", meeting_id: card.closureMeeting!.meetingId, therapist, position });
      if (data.success) { toast.success(`Stanovisko ${therapist === "hanka" ? "Hanky" : "Káti"} uloženo`); setPositionInput(null); onRefetch(); }
      else toast.error(data.error || "Chyba");
    });
  };

  const handleGenerateKarelStatement = async () => {
    if (!card.eventId) return;
    await withLoading("karel_statement", async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "generate_karel_statement", crisis_event_id: card.eventId });
      if (data.success) { toast.success("Karlův finální statement vygenerován"); onRefetch(); }
      else toast.error(data.error || "Chyba");
    });
  };

  const handleCheckReadiness = async () => {
    if (!card.eventId) return;
    await withLoading("check_readiness", async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "check_closure_readiness", crisis_event_id: card.eventId });
      if (data.readiness) { toast.info(data.readiness.overall_ready ? "✅ Všechny 4 vrstvy splněny" : `❌ Blockery: ${data.readiness.all_blockers.length}`); onRefetch(); }
      else toast.error(data.error || "Chyba");
    });
  };

  const handleApproveClosure = async () => {
    if (!card.eventId) return;
    await withLoading("approve_closure", async () => {
      const data = await callFn("approve-crisis-closure", { crisis_event_id: card.eventId });
      if (data.success || data.closed) { toast.success("Krize uzavřena"); onRefetch(); }
      else toast.error(data.error || "Uzavření zamítnuto", { description: data.blockers?.join(", ") });
    });
  };

  const handleRefreshDailyCycle = async () => {
    if (!card.eventId) return;
    await withLoading("refresh_daily", async () => {
      const data = await callFn("karel-did-daily-cycle", { crisis_event_id: card.eventId, part_name: card.partName });
      if (data.error) toast.error(data.error);
      else { toast.success("Denní cyklus aktualizován"); onRefetch(); }
    });
  };

  // ── Derived data ──────────────────────────────────────────────

  const todayStr = new Date().toISOString().slice(0, 10);
  const isPhaseToday = (d: string | null) => d ? d.slice(0, 10) === todayStr : false;
  const dailyCyclePhases = [
    { label: "Ráno", done: isPhaseToday(card.lastMorningReviewAt) },
    { label: "Odpoledne", done: isPhaseToday(card.lastAfternoonReviewAt) },
    { label: "Po sezení", done: isPhaseToday(card.lastOutcomeRecordedAt) },
    { label: "Večer", done: isPhaseToday(card.lastEveningDecisionAt) },
  ];

  const currentState = card.operatingState || "active";
  const allowedTransitions = (ALLOWED_TRANSITIONS[currentState] || []).filter(s => s !== "closed");

  const r4 = card.closureReadiness4Layer;
  const hasBackendReadiness = r4 != null;
  const cl = card.closureChecklistState;

  const localLayers = [
    { label: "Klinická", blockers: [!cl.noRiskSignals && "Rizikové signály", !cl.triggerManaged && "Trigger nezvládnut", cl.emotionalStableDays < 2 && `Stabilita ${cl.emotionalStableDays}/2 dní`].filter(Boolean) as string[] },
    { label: "Procesní", blockers: [!cl.karelDiagnosticDone && "Diagnostické sezení", !cl.noOpenQuestions && "Otevřené otázky", card.unansweredQuestionCount > 0 && `${card.unansweredQuestionCount} nezodpovězených Q`].filter(Boolean) as string[] },
    { label: "Týmová", blockers: [!card.closureMeeting && "Closure meeting nezaložen", card.closureMeeting && !card.closureMeeting.hankaPosition && "Stanovisko Hanky", card.closureMeeting && !card.closureMeeting.kataPosition && "Stanovisko Káti", card.closureMeeting && !card.closureMeeting.karelFinalStatement && "Karlův statement"].filter(Boolean) as string[] },
    { label: "Operační", blockers: [!cl.relapsePlanExists && "Relapse plán", !cl.groundingWorks && "Grounding nefunguje"].filter(Boolean) as string[] },
  ];

  const readinessLayers = hasBackendReadiness ? [
    { label: "Klinická", blockers: r4!.clinical.blockers, met: r4!.clinical.met },
    { label: "Procesní", blockers: r4!.process.blockers, met: r4!.process.met },
    { label: "Týmová", blockers: r4!.team.blockers, met: r4!.team.met },
    { label: "Operační", blockers: r4!.operational.blockers, met: r4!.operational.met },
  ] : localLayers.map(l => ({ ...l, met: l.blockers.length === 0 }));

  const readinessMet = readinessLayers.filter(l => l.met).length;
  const readinessPercent = Math.round((readinessMet / 4) * 100);
  const overallReady = hasBackendReadiness ? r4!.overallReady : readinessLayers.every(l => l.met);

  // Parse Karel analysis from session questions
  const parsedAnalysis = (() => {
    const analyzedQ = card.sessionQuestions.find(q => q.karelAnalysis);
    if (!analyzedQ?.karelAnalysis) return null;
    try { return JSON.parse(analyzedQ.karelAnalysis); } catch { return null; }
  })();

  const ActionBtn: React.FC<{ loadingKey: string; onClick: () => void; children: React.ReactNode; variant?: string; disabled?: boolean }> = ({ loadingKey, onClick, children, variant, disabled }) => {
    const isLoading = actionLoading === loadingKey;
    const base = variant === "danger" ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
      : variant === "success" ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50"
      : "bg-primary/10 text-primary hover:bg-primary/20";
    return (
      <button onClick={onClick} disabled={isLoading || actionLoading != null || disabled}
        className={`text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 ${base}`}>
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        {children}
      </button>
    );
  };

  const SectionHeader: React.FC<{ sectionKey: string; icon: React.ReactNode; title: string; badge?: string }> = ({ sectionKey, icon, title, badge }) => (
    <button onClick={() => toggleSection(sectionKey)} className="flex items-center gap-1.5 w-full text-left">
      {expandedSections[sectionKey] ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
      {icon}
      <span className="text-xs font-bold text-foreground">{title}</span>
      {badge && <span className="text-[9px] bg-muted px-1.5 rounded ml-auto">{badge}</span>}
    </button>
  );

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* Tab bar */}
      <div className="flex border-b text-xs">
        <button onClick={() => setActiveTab("detail")} className={`flex-1 py-2 font-medium transition-colors ${activeTab === "detail" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}>Řízení</button>
        <button onClick={() => setActiveTab("history")} className={`flex-1 py-2 font-medium transition-colors ${activeTab === "history" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}>Historie</button>
      </div>

      {activeTab === "history" ? (
        <div className="p-4 max-h-[60vh] overflow-y-auto"><CrisisHistoryTimeline card={card} /></div>
      ) : (
        <div className="p-4 space-y-4 text-sm max-h-[60vh] overflow-y-auto">

          {/* Status grid */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {[
              { label: "Stav", value: STATE_LABELS[currentState] || currentState },
              { label: "Den", value: card.daysActive ?? "—" },
              { label: "Riziko", value: card.lastAssessmentRisk || "—", className: riskClass },
              { label: "Trend", value: `${trend.emoji} ${trend.label}` },
              { label: "Kontakt", value: card.lastContactAt ? `${Math.round(card.hoursStale)}h` : "—", alert: card.isStale },
            ].map((item, i) => (
              <div key={i} className="bg-muted/50 rounded-lg p-2 text-center">
                <p className="text-[10px] text-muted-foreground">{item.label}</p>
                <p className={`font-bold text-xs ${item.alert ? "text-destructive" : "text-foreground"} ${"className" in item ? (item as any).className : ""}`}>{String(item.value)}</p>
              </div>
            ))}
          </div>

          {/* Clinical summary */}
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Klinické shrnutí</p>
            <p className="text-xs text-foreground">{card.displaySummary}</p>
          </div>

          {/* Ownership */}
          <div className="flex items-center gap-3 text-[11px]">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-foreground font-medium">Vede: {card.primaryTherapist}{card.secondaryTherapist && ` · Podpora: ${card.secondaryTherapist}`}</span>
          </div>

          {/* State machine */}
          {allowedTransitions.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-2">
              <p className="text-xs font-bold text-foreground flex items-center gap-1.5"><ArrowRight className="w-3.5 h-3.5" /> Přechod stavu</p>
              <div className="flex flex-wrap gap-1.5">
                {allowedTransitions.map(ts => (
                  <ActionBtn key={ts} loadingKey={`transition_${ts}`} onClick={() => handleTransitionState(ts)}>{STATE_TRANSITION_LABELS[ts] || ts}</ActionBtn>
                ))}
              </div>
            </div>
          )}

          {/* Karel's latest interview */}
          {card.interviews.length > 0 && (() => {
            const latest = card.interviews[0];
            return (
              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-1">
                <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5" /> Karlův krizový rozhovor
                  {card.todayInterviewDone && <span className="text-[9px] bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">dnes ✓</span>}
                </p>
                {latest.summaryForTeam && <p className="text-xs text-foreground max-h-24 overflow-y-auto whitespace-pre-wrap">{latest.summaryForTeam}</p>}
                {latest.karelDecision && <p className="text-[11px] text-blue-700 dark:text-blue-400"><strong>Rozhodnutí:</strong> {latest.karelDecision}</p>}
                {latest.whatRemains && <p className="text-[11px] text-muted-foreground italic">Zůstává nejasné: {latest.whatRemains}</p>}
                <div className="flex gap-3 text-[10px] text-muted-foreground mt-1">
                  {latest.observedRegulation != null && <span>Regulace: {latest.observedRegulation}/10</span>}
                  {latest.observedTrust != null && <span>Důvěra: {latest.observedTrust}/10</span>}
                  {latest.observedCoherence != null && <span>Koherence: {latest.observedCoherence}/10</span>}
                </div>
              </div>
            );
          })()}

          {/* ══ DAILY CYCLE + EVENING DECISION ══ */}
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5"><CalendarCheck className="w-3.5 h-3.5" /> Denní cyklus</h4>
            <div className="grid grid-cols-4 gap-1.5">
              {dailyCyclePhases.map((ph, i) => (
                <div key={i} className={`text-center rounded-lg p-2 text-[11px] ${ph.done ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300" : "bg-muted/50 text-muted-foreground"}`}>
                  <p className="font-medium">{ph.label}</p>
                  <p className="text-[10px]">{ph.done ? "✅" : "⚠️"}</p>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-2">
              <ActionBtn loadingKey="refresh_daily" onClick={handleRefreshDailyCycle}><RefreshCw className="w-3 h-3" /> Refresh cyklus</ActionBtn>
              {!isPhaseToday(card.lastEveningDecisionAt) && (
                <ActionBtn loadingKey="open_evening" onClick={() => setEveningForm(f => ({ ...f, open: !f.open }))}>
                  <Clock className="w-3 h-3" /> Večerní rozhodnutí
                </ActionBtn>
              )}
            </div>

            {/* Evening decision form */}
            {eveningForm.open && (
              <div className="mt-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 space-y-2">
                <p className="text-xs font-bold text-amber-800 dark:text-amber-300">Večerní rozhodnutí</p>
                <div className="space-y-1.5">
                  {EVENING_DECISIONS.map(d => (
                    <label key={d.value} className={`flex items-start gap-2 text-[11px] p-1.5 rounded cursor-pointer ${eveningForm.decision === d.value ? "bg-amber-100 dark:bg-amber-900/40" : "hover:bg-muted/50"}`}>
                      <input type="radio" name="evening_decision" value={d.value} checked={eveningForm.decision === d.value}
                        onChange={() => setEveningForm(f => ({ ...f, decision: d.value }))} className="mt-0.5" />
                      <div><span className="font-medium text-foreground">{d.label}</span><p className="text-muted-foreground text-[10px]">{d.desc}</p></div>
                    </label>
                  ))}
                </div>
                <textarea placeholder="Poznámky k rozhodnutí…" value={eveningForm.notes}
                  onChange={e => setEveningForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full text-[11px] px-2 py-1.5 rounded border bg-background text-foreground min-h-[40px] resize-none" />
                <textarea placeholder="Plán na další den (volitelné)…" value={eveningForm.nextDayPlan}
                  onChange={e => setEveningForm(f => ({ ...f, nextDayPlan: e.target.value }))}
                  className="w-full text-[11px] px-2 py-1.5 rounded border bg-background text-foreground min-h-[30px] resize-none" />
                <ActionBtn loadingKey="evening_decision" onClick={handleSubmitEveningDecision} disabled={!eveningForm.decision}>
                  <Send className="w-3 h-3" /> Odeslat rozhodnutí
                </ActionBtn>
              </div>
            )}
          </div>

          {/* ══ POST-SESSION Q/A ══ */}
          {card.sessionQuestions.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-2">
              <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5" />
                Otázky po sezení ({card.sessionQuestions.length - card.unansweredQuestionCount}/{card.sessionQuestions.length})
                {card.sessionQAComplete && <span className="text-[9px] bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">kompletní</span>}
              </p>

              <div className="space-y-2 max-h-48 overflow-y-auto">
                {card.sessionQuestions.map(q => (
                  <div key={q.id} className={`rounded-lg p-2 text-[11px] ${q.answeredAt ? "bg-green-50 dark:bg-green-950/20" : "bg-amber-50 dark:bg-amber-950/20"}`}>
                    <div className="flex items-start gap-1.5">
                      {q.answeredAt ? <CheckCircle className="w-3 h-3 text-green-600 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />}
                      <div className="flex-1">
                        <p className="text-foreground font-medium">{q.questionText}</p>
                        <p className="text-muted-foreground text-[10px]">{q.therapistName === "hanka" ? "Hanička" : "Káťa"}
                          {q.requiredBy && ` · deadline: ${new Date(q.requiredBy).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`}
                          {q.qualityScore != null && ` · kvalita: ${q.qualityScore}/10`}
                        </p>
                        {q.answeredAt && q.answerText && (
                          <p className="text-foreground mt-1 bg-background/50 rounded p-1.5">{q.answerText}</p>
                        )}
                        {/* Answer input for unanswered */}
                        {!q.answeredAt && (
                          <div className="flex gap-1 mt-1.5">
                            <input className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground"
                              placeholder="Odpověď…" value={answerInputs[q.id] || ""}
                              onChange={e => setAnswerInputs(prev => ({ ...prev, [q.id]: e.target.value }))} />
                            <ActionBtn loadingKey={`qa_${q.id}`} onClick={() => handleSubmitQAAnswer(q.id)} disabled={!answerInputs[q.id]?.trim()}>
                              <Send className="w-3 h-3" />
                            </ActionBtn>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Karel analysis result */}
              {parsedAnalysis && (
                <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded p-2 space-y-1 text-[10px]">
                  <p className="font-bold text-blue-800 dark:text-blue-300 text-[11px]">Karlova analýza</p>
                  <div className="grid grid-cols-2 gap-1">
                    {parsedAnalysis.intervention_effectiveness && <p><strong>Efektivita:</strong> {parsedAnalysis.intervention_effectiveness}</p>}
                    {parsedAnalysis.stabilization_trend && <p><strong>Trend:</strong> {parsedAnalysis.stabilization_trend}</p>}
                    {parsedAnalysis.main_risk && <p className="col-span-2"><strong>Hlavní riziko:</strong> {parsedAnalysis.main_risk}</p>}
                    {parsedAnalysis.next_action && <p className="col-span-2"><strong>Další krok:</strong> {parsedAnalysis.next_action}</p>}
                    {parsedAnalysis.karel_recommendation && <p className="col-span-2"><strong>Doporučení:</strong> {parsedAnalysis.karel_recommendation}</p>}
                  </div>
                  <div className="flex gap-2 text-[9px] text-muted-foreground mt-1">
                    {parsedAnalysis.needs_follow_up_session && <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 px-1 rounded">Potřeba follow-up</span>}
                    {parsedAnalysis.needs_crisis_meeting && <span className="bg-destructive/10 text-destructive px-1 rounded">Potřeba porady</span>}
                    {parsedAnalysis.prepare_closure && <span className="bg-green-100 dark:bg-green-900/30 text-green-700 px-1 rounded">Připravit uzavření</span>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Required outputs */}
          {card.todayRequiredOutputs.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Povinné výstupy dne</h4>
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

          {/* Awaiting response */}
          {card.awaitingResponseFrom.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <p className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><MessageSquareDashed className="w-3.5 h-3.5" /> Čeká se na odpověď</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{card.awaitingResponseFrom.map(n => n === "hanka" ? "Hanička" : n === "kata" ? "Káťa" : n).join(", ")}</p>
            </div>
          )}

          {/* ══ CLOSURE WORKFLOW ══ */}
          <div className="bg-muted/30 rounded-lg p-3 space-y-2">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {card.closureMeeting ? "Closure Meeting" : "Krizová porada"}</p>
            {card.closureMeeting ? (
              <div className="space-y-2">
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
                {card.closureMeeting.hankaPosition && <p className="text-[10px] text-muted-foreground"><strong>Hanka:</strong> {card.closureMeeting.hankaPosition.slice(0, 150)}</p>}
                {card.closureMeeting.kataPosition && <p className="text-[10px] text-muted-foreground"><strong>Káťa:</strong> {card.closureMeeting.kataPosition.slice(0, 150)}</p>}
                {card.closureMeeting.karelFinalStatement && (
                  <div className="bg-blue-50 dark:bg-blue-950/20 rounded p-2 text-[10px] text-blue-800 dark:text-blue-300 max-h-20 overflow-y-auto whitespace-pre-wrap">
                    <strong>Karel:</strong> {card.closureMeeting.karelFinalStatement.slice(0, 300)}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/50">
                  {!card.closureMeeting.hankaPosition && (
                    positionInput?.therapist === "hanka" ? (
                      <div className="flex gap-1 w-full">
                        <input className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground" placeholder="Stanovisko Hanky…"
                          value={positionInput.text} onChange={e => setPositionInput({ therapist: "hanka", text: e.target.value })} />
                        <ActionBtn loadingKey="position_hanka" onClick={() => handleSubmitPosition("hanka", positionInput.text)}>Uložit</ActionBtn>
                      </div>
                    ) : <ActionBtn loadingKey="position_hanka" onClick={() => setPositionInput({ therapist: "hanka", text: "" })}>Zapsat stanovisko Hanky</ActionBtn>
                  )}
                  {!card.closureMeeting.kataPosition && (
                    positionInput?.therapist === "kata" ? (
                      <div className="flex gap-1 w-full">
                        <input className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground" placeholder="Stanovisko Káti…"
                          value={positionInput.text} onChange={e => setPositionInput({ therapist: "kata", text: e.target.value })} />
                        <ActionBtn loadingKey="position_kata" onClick={() => handleSubmitPosition("kata", positionInput.text)}>Uložit</ActionBtn>
                      </div>
                    ) : <ActionBtn loadingKey="position_kata" onClick={() => setPositionInput({ therapist: "kata", text: "" })}>Zapsat stanovisko Káti</ActionBtn>
                  )}
                  {!card.closureMeeting.karelFinalStatement && (
                    <ActionBtn loadingKey="karel_statement" onClick={handleGenerateKarelStatement}><Brain className="w-3 h-3" /> Vygenerovat Karlův statement</ActionBtn>
                  )}
                </div>
              </div>
            ) : card.crisisMeetingRequired ? (
              <div className="space-y-1">
                <p className="text-xs text-destructive font-medium">⚠ Doporučená — zatím neotevřena</p>
                <ActionBtn loadingKey="initiate_closure" onClick={handleInitiateClosureMeeting}>Otevřít krizovou poradu</ActionBtn>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Není potřeba</p>
                {card.eventId && <ActionBtn loadingKey="initiate_closure" onClick={handleInitiateClosureMeeting}><Users className="w-3 h-3" /> Svolat closure meeting</ActionBtn>}
              </div>
            )}
          </div>

          {/* Karel requires */}
          {card.karelRequires.length > 0 && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
              <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Karel vyžaduje</p>
              <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1 space-y-1 list-disc list-inside">
                {card.karelRequires.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {/* 4-Layer Closure Readiness */}
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" /> Připravenost k uzavření ({readinessPercent}%)
              <span className={`text-[9px] px-1.5 rounded ml-1 ${hasBackendReadiness ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300" : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"}`}>
                {hasBackendReadiness ? "backend ✓" : "lokální odhad"}
              </span>
            </h4>
            <Progress value={readinessPercent} className="h-2 mb-3" />
            <div className="space-y-2">
              {readinessLayers.map((layer, i) => (
                <div key={i} className="text-[11px] flex items-center gap-1.5">
                  {layer.met ? <CheckCircle className="w-3 h-3 text-green-600" /> : <AlertTriangle className="w-3 h-3 text-amber-500" />}
                  <span className={layer.met ? "text-muted-foreground" : "text-foreground font-medium"}>{layer.label}</span>
                  {!layer.met && <span className="text-muted-foreground">— {layer.blockers.join(", ")}</span>}
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-2">
              <ActionBtn loadingKey="check_readiness" onClick={handleCheckReadiness}><RefreshCw className="w-3 h-3" /> Zkontrolovat readiness</ActionBtn>
              {overallReady && <ActionBtn loadingKey="approve_closure" onClick={handleApproveClosure} variant="success"><CheckCircle className="w-3 h-3" /> Uzavřít krizi</ActionBtn>}
            </div>
          </div>

          {/* Therapist profiling removed — data lives in PAMET_KAREL only */}

          {/* ══ PART CARD PROPAGATION STATUS ══ */}
          <div>
            <SectionHeader sectionKey="card_prop" icon={<Database className="w-3.5 h-3.5 text-muted-foreground" />}
              title="Propis do karty části" badge={card.cardPropagationStatus.length > 0 ? `${card.cardPropagationStatus.length} zápisů` : "—"} />
            {expandedSections.card_prop && (
              <div className="mt-2 space-y-1">
                {card.cardPropagationStatus.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">Žádné záznamy o propagaci</p>
                ) : card.cardPropagationStatus.map((e, i) => (
                  <AuditRow key={i} entry={e} />
                ))}
              </div>
            )}
          </div>

          {/* ══ 05A SYNC STATUS ══ */}
          <div>
            <SectionHeader sectionKey="plan_sync" icon={<FileText className="w-3.5 h-3.5 text-muted-foreground" />}
              title="05A sync status" badge={card.planSyncStatus ? (card.planSyncStatus.status === "ok" ? "✓" : card.planSyncStatus.status) : "—"} />
            {expandedSections.plan_sync && (
              <div className="mt-2">
                {card.planSyncStatus ? (
                  <AuditRow entry={card.planSyncStatus} />
                ) : (
                  <p className="text-[10px] text-muted-foreground">Žádný záznam o 05A sync</p>
                )}
              </div>
            )}
          </div>

          {/* Open tasks */}
          {card.openTasks.length > 0 && (
            <div>
              <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Úkoly ({card.openTasks.length})</h4>
              <div className="space-y-1.5">
                {card.openTasks.map(t => (
                  <div key={t.id} className="text-[11px]">
                    <p className="text-xs font-medium text-foreground">{t.title}</p>
                    <p className="text-[10px] text-muted-foreground">{t.assignedTo} · {t.priority}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom actions */}
          {card.alertId && (
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              <ActionBtn loadingKey="acknowledge" onClick={async () => {
                const { data: { user } } = await supabase.auth.getUser();
                const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
                await supabase.from("crisis_alerts").update({ status: "ACKNOWLEDGED", acknowledged_by: userName, acknowledged_at: new Date().toISOString() }).eq("id", card.alertId);
                onRefetch();
              }}>
                <CheckCircle className="w-3 h-3" /> Vzít na vědomí
              </ActionBtn>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Sub-components ──────────────────────────────────────────────


const AuditRow: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const statusColor = entry.status === "ok" ? "text-green-600" : entry.status === "failed" ? "text-destructive" : "text-muted-foreground";
  const statusIcon = entry.status === "ok" ? "✅" : entry.status === "failed" ? "❌" : "⏳";
  return (
    <div className="flex items-start gap-2 text-[10px]">
      <span>{statusIcon}</span>
      <div className="flex-1">
        <span className={`font-medium ${statusColor}`}>{entry.source}</span>
        {entry.timestamp && <span className="text-muted-foreground ml-1">{new Date(entry.timestamp).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
        {entry.detail && <p className="text-muted-foreground">{entry.detail}</p>}
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;
