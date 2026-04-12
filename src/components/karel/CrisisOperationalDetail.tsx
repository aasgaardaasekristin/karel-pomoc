import React from "react";
import { Activity, CheckCircle, AlertTriangle, Clock, Users, HelpCircle, Target, Zap, ShieldAlert, ArrowRight, CalendarCheck, MessageSquareDashed } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

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
  const trend = TREND_LABELS[card.trend48h] || TREND_LABELS.unknown;
  const riskClass = RISK_COLORS[card.lastAssessmentRisk || ""] || "bg-muted text-foreground";

  const handleAcknowledge = async () => {
    if (!card.alertId) return;
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase.from("crisis_alerts").update({
      status: "ACKNOWLEDGED",
      acknowledged_by: userName,
      acknowledged_at: new Date().toISOString(),
    }).eq("id", card.alertId);
    onRefetch();
  };

  const handleProposeClosure = async () => {
    if (!card.alertId) return;
    try {
      await supabase.from("crisis_closure_checklist").upsert({
        crisis_alert_id: card.alertId,
        karel_recommends_closure: true,
        karel_closure_recommendation: "Karel navrhuje uzavření krize — klinická kritéria splněna",
      } as any, { onConflict: "crisis_alert_id" });
      toast.success("Návrh na uzavření odeslán — čeká na souhlas obou terapeutek");
      onRefetch();
    } catch {
      toast.error("Nepodařilo se odeslat návrh na uzavření");
    }
  };

  const handleToggleTask = async (taskId: string, currentStatus: string) => {
    const newStatus = currentStatus === "DONE" ? "PENDING" : "DONE";
    await supabase.from("crisis_tasks").update({
      status: newStatus,
      completed_at: newStatus === "DONE" ? new Date().toISOString() : null,
    }).eq("id", taskId);
    onRefetch();
  };

  const closurePercent = Math.round(card.closureReadiness * 100);
  const cl = card.closureChecklistState;

  const missingItems: string[] = [];
  if (!cl.karelDiagnosticDone) missingItems.push("Diagnostické sezení");
  if (!cl.noRiskSignals) missingItems.push("Bez rizikových signálů");
  if (cl.emotionalStableDays < 3) missingItems.push(`Emoční stabilita (${cl.emotionalStableDays}/3 dnů)`);
  if (!cl.groundingWorks) missingItems.push("Grounding funguje");
  if (!cl.triggerManaged) missingItems.push("Trigger zvládnut");
  if (!cl.noOpenQuestions) missingItems.push("Otevřené otázky");
  if (!cl.relapsePlanExists) missingItems.push("Plán relapsu");
  if (!cl.hankaAgrees) missingItems.push("Souhlas Haničky");
  if (!cl.kataAgrees) missingItems.push("Souhlas Káti");
  if (!cl.karelRecommendsClosure) missingItems.push("Karlovo doporučení");

  // Daily checklist items
  const dc = card.dailyChecklist;
  const dailyChecklistItems = [
    { label: "Dnešní stav zjištěn", done: dc.statusChecked },
    { label: "Poslední update ověřen", done: dc.lastUpdateVerified },
    { label: "Bezpečí ověřeno", done: dc.safetyConfirmed },
    { label: "Kontakt / sezení proběhlo", done: dc.contactCompleted },
    { label: "Výsledek zásahu zapsán", done: dc.interventionRecorded },
    { label: "Terapeutky reagovaly", done: dc.therapistsResponded },
    { label: "Další krok určen", done: dc.nextStepDetermined },
    { label: "Rozhodnutí dne", done: dc.decisionMade },
  ];
  const dailyCompleted = dailyChecklistItems.filter(i => i.done).length;

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      <div className="p-4 space-y-4 text-sm max-h-[60vh] overflow-y-auto">

        {/* ── Status grid ── */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: "Fáze", value: card.phase === "acute" ? "akutní" : card.phase === "stabilizing" ? "stabilizace" : card.phase === "diagnostic" ? "diagnostika" : card.phase === "closing" ? "uzavírání" : card.phase === "ready_to_close" ? "k uzavření" : "aktivní" },
            { label: "Den", value: card.daysActive ?? "—" },
            { label: "Riziko", value: card.lastAssessmentRisk || "—", className: riskClass },
            { label: "Trend 48h", value: `${trend.emoji} ${trend.label}` },
            { label: "Poslední kontakt", value: card.lastContactAt ? `${Math.round(card.hoursStale)}h` : "—", alert: card.isStale },
            ...(card.stableHours != null ? [{ label: "Stabilní", value: `${Math.round(card.stableHours)}h` }] : []),
          ].map((item, i) => (
            <div key={i} className="bg-muted/50 rounded-lg p-2 text-center">
              <p className="text-[10px] text-muted-foreground">{item.label}</p>
              <p className={`font-bold text-xs ${item.alert ? "text-destructive" : "text-foreground"} ${"className" in item ? item.className : ""}`}>
                {String(item.value)}
              </p>
            </div>
          ))}
        </div>

        {/* ── Ownership ── */}
        <div className="flex items-center gap-3 text-[11px]">
          <Users className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-foreground font-medium">
            Vede: {card.primaryTherapist}
            {card.secondaryTherapist && ` · Podpora: ${card.secondaryTherapist}`}
          </span>
          {card.ownershipSource === "heuristic" && (
            <span className="text-[10px] text-muted-foreground italic">(odhad)</span>
          )}
          {card.ownershipSource === "unknown" && (
            <span className="text-[10px] text-amber-600 font-medium">neurčeno</span>
          )}
        </div>

        {/* ── Indicators ── */}
        {card.indicators.safety !== null && (
          <div className="flex flex-wrap gap-3 text-[11px]">
            {[
              { label: "Bezpečí", value: card.indicators.safety },
              { label: "Koherence", value: card.indicators.coherence },
              { label: "Regulace", value: card.indicators.emotionalRegulation },
              { label: "Důvěra", value: card.indicators.trust },
              { label: "Čas. orientace", value: card.indicators.timeOrientation },
            ].filter(i => i.value !== null).map((ind, i) => (
              <span key={i} className={`px-2 py-0.5 rounded ${(ind.value ?? 0) <= 3 ? "bg-destructive/10 text-destructive" : (ind.value ?? 0) <= 6 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"}`}>
                {ind.label}: {ind.value}/10
              </span>
            ))}
          </div>
        )}

        {/* ── Trigger info ── */}
        {card.triggerDescription && (
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5" />
              Trigger
            </p>
            <p className="text-xs text-foreground">{card.triggerDescription}</p>
            {card.triggerActive !== null && (
              <p className="text-[10px] text-muted-foreground">
                {card.triggerActive ? "⚠ Trigger stále aktivní" : "✅ Trigger zvládnut"}
              </p>
            )}
          </div>
        )}

        {/* ── Last intervention ── */}
        {card.lastInterventionType && (
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              Poslední intervence
            </p>
            <p className="text-xs text-foreground">
              Typ: {card.lastInterventionType}
              {card.lastInterventionWorked === true && " — ✅ fungovala"}
              {card.lastInterventionWorked === false && " — ❌ nefungovala"}
            </p>
          </div>
        )}

        {/* ── 24h change / last entry ── */}
        {card.lastEntrySummary && (
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Co se změnilo za 24h
            </p>
            <p className="text-xs text-foreground">{card.lastEntrySummary}</p>
            {card.lastEntryBy && (
              <p className="text-[10px] text-muted-foreground">Zapsala: {card.lastEntryBy}</p>
            )}
          </div>
        )}

        {/* ── Clinical / display summary ── */}
        <div className="bg-muted/30 rounded-lg p-3 space-y-1">
          <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            Klinické shrnutí
            {!card.clinicalSummary && <span className="text-[9px] text-muted-foreground font-normal">(runtime)</span>}
          </p>
          <p className="text-xs text-foreground">{card.displaySummary}</p>
        </div>

        {/* ── Karel's next step ── */}
        {card.karelRequires.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" />
              Karel vyžaduje
            </p>
            <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1 space-y-1 list-disc list-inside">
              {card.karelRequires.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
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

        {/* ── Required outputs ── */}
        {card.todayRequiredOutputs.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" />
              Povinné výstupy dne
            </h4>
            <div className="space-y-1">
              {card.todayRequiredOutputs.map((o, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  {o.fulfilled ? (
                    <CheckCircle className="w-3 h-3 text-green-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                  )}
                  <span className={o.fulfilled ? "text-muted-foreground" : "text-foreground font-medium"}>{o.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Daily checklist ── */}
        <div>
          <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
            <CalendarCheck className="w-3.5 h-3.5" />
            Denní checklist ({dailyCompleted}/{dailyChecklistItems.length})
          </h4>
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            {dailyChecklistItems.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {item.done ? (
                  <CheckCircle className="w-3 h-3 text-green-600 dark:text-green-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                )}
                <span className={item.done ? "text-muted-foreground" : "text-foreground font-medium"}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Crisis meeting status ── */}
        {card.crisisMeetingRequired && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3">
            <p className="text-xs font-bold text-destructive flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Porada vyžadována
            </p>
            {card.crisisMeetingReason && (
              <p className="text-xs text-destructive/80 mt-1">{card.crisisMeetingReason}</p>
            )}
          </div>
        )}

        {/* ── Missing for closure ── */}
        {missingItems.length > 0 && missingItems.length < 10 && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
            <p className="text-xs font-bold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" />
              Co chybí k uzavření ({missingItems.length})
            </p>
            <ul className="text-xs text-amber-700 dark:text-amber-400 mt-1 space-y-0.5 list-disc list-inside">
              {missingItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Open tasks ── */}
        {card.openTasks.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" />
              Úkoly ({card.openTasks.length})
            </h4>
            <div className="space-y-1.5">
              {card.openTasks.map(t => (
                <label key={t.id} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={t.status === "DONE"}
                    onChange={() => handleToggleTask(t.id, t.status)}
                    className="mt-0.5 accent-destructive"
                  />
                  <div>
                    <p className={`text-xs font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {t.assignedTo} · {t.priority}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* ── Pending questions ── */}
        {card.pendingQuestions.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5" />
              Otevřené otázky ({card.pendingQuestions.length})
            </h4>
            <div className="space-y-1">
              {card.pendingQuestions.map(q => (
                <div key={q.id} className="text-xs bg-muted/40 rounded p-2">
                  <p className="text-foreground">{q.question}</p>
                  {q.directedTo && <p className="text-[10px] text-muted-foreground mt-0.5">Pro: {q.directedTo}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Closure readiness (10 items) ── */}
        <div>
          <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" />
            Připravenost k uzavření ({closurePercent}%)
          </h4>
          <Progress value={closurePercent} className="h-2 mb-2" />
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            {[
              { label: "Diagnostické sezení", done: cl.karelDiagnosticDone },
              { label: "Bez rizikových signálů", done: cl.noRiskSignals },
              { label: `Emoční stabilita ≥ 3d (${cl.emotionalStableDays}d)`, done: cl.emotionalStableDays >= 3 },
              { label: "Grounding funguje", done: cl.groundingWorks },
              { label: "Trigger zvládnut", done: cl.triggerManaged },
              { label: "Bez otevřených otázek", done: cl.noOpenQuestions },
              { label: "Plán relapsu existuje", done: cl.relapsePlanExists },
              { label: "Hanička souhlasí", done: cl.hankaAgrees },
              { label: "Káťa souhlasí", done: cl.kataAgrees },
              { label: "Karel doporučuje uzavření", done: cl.karelRecommendsClosure },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {item.done ? (
                  <CheckCircle className="w-3 h-3 text-green-600 dark:text-green-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                )}
                <span className={item.done ? "text-muted-foreground" : "text-foreground font-medium"}>{item.label}</span>
              </div>
            ))}
          </div>
          {cl.closureRecommendation && (
            <p className="text-[11px] text-muted-foreground mt-1.5 italic">{cl.closureRecommendation}</p>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex flex-wrap gap-2 pt-2 border-t">
          {card.alertId && (
            <button
              onClick={handleAcknowledge}
              className="text-xs px-3 py-1.5 rounded-md bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 flex items-center gap-1.5 transition-colors"
            >
              <CheckCircle className="w-3 h-3" />
              Vzít na vědomí
            </button>
          )}
          {card.canProposeClosing && !cl.karelRecommendsClosure && (
            <button
              onClick={handleProposeClosure}
              className="text-xs px-3 py-1.5 rounded-md bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 text-green-800 dark:text-green-300 flex items-center gap-1.5 transition-colors"
            >
              <CheckCircle className="w-3 h-3" />
              Navrhnout uzavření
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;
