import React, { useState } from "react";
import { Activity, CheckCircle, AlertTriangle, Clock, Users, HelpCircle, Target } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
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

const DECISION_LABELS: Record<string, string> = {
  crisis_continues: "Krize trvá",
  crisis_improving: "Zlepšení",
  crisis_resolved: "Vyřešeno",
  needs_more_data: "Potřeba dat",
};

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch }) => {
  const [resolveNotes, setResolveNotes] = useState("");
  const [showResolveInput, setShowResolveInput] = useState(false);

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

  const handleResolve = async () => {
    if (!card.alertId || !resolveNotes.trim()) return;
    await supabase.from("crisis_alerts").update({
      status: "RESOLVED",
      resolved_at: new Date().toISOString(),
      resolution_notes: resolveNotes,
    }).eq("id", card.alertId);
    setResolveNotes("");
    setShowResolveInput(false);
    onRefetch();
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

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      <div className="p-4 space-y-4 text-sm max-h-[60vh] overflow-y-auto">

        {/* ── Status grid ── */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: "Fáze", value: card.phase === "acute" ? "akutní" : card.phase === "stabilizing" ? "stabilizace" : card.phase === "diagnostic" ? "diagnostika" : card.phase === "closing" ? "uzavírání" : "aktivní" },
            { label: "Den", value: card.daysActive ?? "—" },
            { label: "Riziko", value: card.lastAssessmentRisk || "—", className: riskClass },
            { label: "Trend 48h", value: `${trend.emoji} ${trend.label}` },
            { label: "Poslední kontakt", value: card.lastContactAt ? `${Math.round(card.hoursStale)}h` : "—", alert: card.isStale },
          ].map((item, i) => (
            <div key={i} className="bg-muted/50 rounded-lg p-2 text-center">
              <p className="text-[10px] text-muted-foreground">{item.label}</p>
              <p className={`font-bold text-xs ${item.alert ? "text-destructive" : "text-foreground"} ${"className" in item ? item.className : ""}`}>
                {String(item.value)}
              </p>
            </div>
          ))}
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

        {/* ── Karel vyžaduje ── */}
        {card.karelRequires.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5" />
              Karel vyžaduje ({card.karelRequires.length})
            </p>
            <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1.5 space-y-1 list-disc list-inside">
              {card.karelRequires.map((r, i) => (
                <li key={i}>{r}</li>
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

        {/* ── Closure readiness ── */}
        <div>
          <h4 className="text-xs font-bold text-foreground mb-2 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" />
            Připravenost k uzavření ({closurePercent}%)
          </h4>
          <Progress value={closurePercent} className="h-2 mb-2" />
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            {[
              { label: "Diagnostické sezení", done: cl.karelDiagnosticDone },
              { label: "Hanička souhlasí", done: cl.hankaAgrees },
              { label: "Káťa souhlasí", done: cl.kataAgrees },
              { label: "Bez rizikových signálů", done: cl.noRiskSignals },
              { label: `Emoční stabilita ≥ 3d (${cl.emotionalStableDays}d)`, done: cl.emotionalStableDays >= 3 },
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
          {!showResolveInput && card.canStartClosing && (
            <button
              onClick={() => setShowResolveInput(true)}
              className="text-xs px-3 py-1.5 rounded-md bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 text-green-800 dark:text-green-300 flex items-center gap-1.5 transition-colors"
            >
              <CheckCircle className="w-3 h-3" />
              Navrhnout uzavření
            </button>
          )}
        </div>

        {/* ── Resolve input ── */}
        {showResolveInput && (
          <div className="space-y-2 pt-2 border-t">
            <textarea
              value={resolveNotes}
              onChange={e => setResolveNotes(e.target.value)}
              placeholder="Popište jak byla krize vyřešena..."
              className="w-full border rounded-lg p-3 text-xs min-h-[60px] bg-background text-foreground"
            />
            <div className="flex gap-2">
              <button
                onClick={handleResolve}
                disabled={!resolveNotes.trim()}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition-colors"
              >
                Potvrdit uzavření
              </button>
              <button
                onClick={() => setShowResolveInput(false)}
                className="px-3 py-1.5 border rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
              >
                Zrušit
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;
