import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity, AlertTriangle, Clock, Users, Target, CalendarCheck,
  MessageSquareDashed, ArrowRight, RefreshCw, Loader2, Send, Brain,
  Play, ClipboardList, Handshake,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import { ALLOWED_TRANSITIONS, STATE_TRANSITION_LABELS } from "@/hooks/useCrisisOperationalState";

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

async function callFn(fnName: string, body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

const CrisisDailyManagement: React.FC<Props> = ({ card, onRefetch }) => {
  const navigate = useNavigate();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [eveningForm, setEveningForm] = useState<{ open: boolean; decision: string; notes: string; nextDayPlan: string }>({
    open: false, decision: "", notes: "", nextDayPlan: "",
  });

  // ── Workflow akce (přesunuto z banneru sem v Crisis Banner Repair Pass) ──

  const navigateToCrisisThread = (partName: string, eventId: string | null) => {
    const params = new URLSearchParams();
    params.set("crisis_action", "interview");
    params.set("part_name", partName);
    if (eventId) params.set("crisis_event_id", eventId);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch { /* ignore */ }
    navigate(`/chat?${params.toString()}`);
  };

  const navigateToFeedback = (eventId: string | null) => {
    const params = new URLSearchParams();
    params.set("crisis_action", "feedback");
    if (eventId) params.set("crisis_event_id", eventId);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch { /* ignore */ }
    navigate(`/chat?${params.toString()}`);
  };

  const handleStartAssessment = async () => {
    if (!card.eventId) return;
    await withLoading("start_assessment", async () => {
      const data = await callFn("karel-crisis-daily-assessment", {
        crisis_event_id: card.eventId,
        crisis_alert_id: card.alertId,
        part_name: card.partName,
      });
      if (data?.error) {
        toast.error(`Spuštění hodnocení selhalo: ${data.error}`);
        return;
      }
      toast.success("Dnešní hodnocení založeno — otevírám krizové vlákno");
      navigateToCrisisThread(card.partName, card.eventId);
    });
  };

  const handleRequestFeedback = async () => {
    if (!card.eventId) return;
    await withLoading("request_feedback", async () => {
      const data = await callFn("karel-crisis-daily-assessment", {
        crisis_event_id: card.eventId,
        crisis_alert_id: card.alertId,
        part_name: card.partName,
        generate_therapist_questions: true,
      });
      if (data?.error) {
        toast.error(`Generování otázek selhalo: ${data.error}`);
        return;
      }
      toast.success("Otázky pro terapeutky vygenerovány — otevírám feedback");
      navigateToFeedback(card.eventId);
    });
  };

  /**
   * Otevřít poradu — najde existující open deliberation pro tuto krizi
   * a otevře ji v Pracovně přes sessionStorage bridge `karel_open_deliberation_id`,
   * který DidDashboard přečte v useEffect a setne openDeliberationId.
   * Pokud žádná open porada neexistuje, naviguje do Pracovny, kde žije
   * `TeamDeliberationsPanel` a uživatel může poradu otevřít/založit.
   */
  const handleOpenMeeting = async () => {
    await withLoading("open_meeting", async () => {
      let deliberationId: string | null = null;
      if (card.eventId) {
        try {
          const { data } = await (supabase as any)
            .from("did_team_deliberations")
            .select("id")
            .eq("crisis_event_id", card.eventId)
            .neq("status", "finalized")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          deliberationId = (data as { id?: string } | null)?.id ?? null;
        } catch { /* fall through to dashboard */ }
      }

      if (deliberationId) {
        try { sessionStorage.setItem("karel_open_deliberation_id", deliberationId); } catch { /* ignore */ }
        toast.success("Otevírám poradu týmu");
      } else {
        toast.info("Žádná otevřená porada — otevírám sekci Porady v Pracovně");
      }
      try { sessionStorage.setItem("karel_hub_section", "did"); } catch { /* ignore */ }
      try { sessionStorage.setItem("karel_terapeut_surface", "pracovna"); } catch { /* ignore */ }
      navigate("/chat");
    });
  };

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setActionLoading(key);
    try { await fn(); } finally { setActionLoading(null); }
  };

  const ActionBtn: React.FC<{ loadingKey: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }> = ({ loadingKey, onClick, children, disabled }) => {
    const isLoading = actionLoading === loadingKey;
    return (
      <button onClick={onClick} disabled={isLoading || actionLoading != null || disabled}
        className="text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 bg-primary/10 text-primary hover:bg-primary/20">
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}{children}
      </button>
    );
  };

  const currentState = card.operatingState || "active";
  const allowedTransitions = (ALLOWED_TRANSITIONS[currentState] || []).filter(s => s !== "closed");
  const trend = TREND_LABELS[card.trend48h] || TREND_LABELS.unknown;
  const riskClass = RISK_COLORS[card.lastAssessmentRisk || ""] || "bg-muted text-foreground";

  const todayStr = new Date().toISOString().slice(0, 10);
  const isPhaseToday = (d: string | null) => d ? d.slice(0, 10) === todayStr : false;
  const dailyCyclePhases = [
    { label: "Ráno", done: isPhaseToday(card.lastMorningReviewAt) },
    { label: "Odpoledne", done: isPhaseToday(card.lastAfternoonReviewAt) },
    { label: "Po sezení", done: isPhaseToday(card.lastOutcomeRecordedAt) },
    { label: "Večer", done: isPhaseToday(card.lastEveningDecisionAt) },
  ];

  const handleTransitionState = async (targetState: string) => {
    if (!card.eventId) return;
    await withLoading(`transition_${targetState}`, async () => {
      const data = await callFn("karel-crisis-closure-meeting", { action: "transition_state", crisis_event_id: card.eventId, target_state: targetState, reason: "manuální přechod z UI" });
      if (data.success) { toast.success(`Stav změněn: ${STATE_LABELS[targetState] || targetState}`); onRefetch(); }
      else toast.error(data.error || "Přechod zamítnut", { description: data.blockers?.join(", ") });
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

  const handleSubmitEveningDecision = async () => {
    if (!card.eventId || !eveningForm.decision) return;
    await withLoading("evening_decision", async () => {
      const data = await callFn("karel-did-daily-cycle", {
        action: "submit_evening_decision", crisis_event_id: card.eventId,
        decision: eveningForm.decision, notes: eveningForm.notes || undefined, next_day_plan: eveningForm.nextDayPlan || undefined,
      });
      if (data.success) {
        toast.success(`Večerní rozhodnutí: ${eveningForm.decision}${data.state_changed ? ` → ${data.new_state}` : ""}`);
        setEveningForm({ open: false, decision: "", notes: "", nextDayPlan: "" });
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  return (
    <div className="space-y-4">
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

      {/* Daily cycle */}
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

      {/* Required outputs */}
      {card.todayRequiredOutputs.length > 0 && (
        <div>
          <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Povinné výstupy dne</h4>
          <div className="space-y-1">
            {card.todayRequiredOutputs.map((o, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                {o.fulfilled ? <Activity className="w-3 h-3 text-green-600 shrink-0" /> : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
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

      {/* Karel requires */}
      {card.karelRequires.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
          <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Karel vyžaduje</p>
          <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1 space-y-1 list-disc list-inside">
            {card.karelRequires.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

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
    </div>
  );
};

export default CrisisDailyManagement;
