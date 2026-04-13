import React, { useState } from "react";
import { CheckCircle, AlertTriangle, Users, Brain, RefreshCw, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

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

const CrisisClosureWorkflow: React.FC<Props> = ({ card, onRefetch }) => {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [positionInput, setPositionInput] = useState<{ therapist: string; text: string } | null>(null);

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setActionLoading(key);
    try { await fn(); } finally { setActionLoading(null); }
  };

  const ActionBtn: React.FC<{ loadingKey: string; onClick: () => void; children: React.ReactNode; variant?: string; disabled?: boolean }> = ({ loadingKey, onClick, children, variant, disabled }) => {
    const isLoading = actionLoading === loadingKey;
    const base = variant === "success" ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50"
      : "bg-primary/10 text-primary hover:bg-primary/20";
    return (
      <button onClick={onClick} disabled={isLoading || actionLoading != null || disabled}
        className={`text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 ${base}`}>
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}{children}
      </button>
    );
  };

  // 4-layer readiness
  const r4 = card.closureReadiness4Layer;
  const cl = card.closureChecklistState;
  const localLayers = [
    { label: "Klinická", blockers: [!cl.noRiskSignals && "Rizikové signály", !cl.triggerManaged && "Trigger nezvládnut", cl.emotionalStableDays < 2 && `Stabilita ${cl.emotionalStableDays}/2 dní`].filter(Boolean) as string[] },
    { label: "Procesní", blockers: [!cl.karelDiagnosticDone && "Diagnostické sezení", !cl.noOpenQuestions && "Otevřené otázky", card.unansweredQuestionCount > 0 && `${card.unansweredQuestionCount} nezodpovězených Q`].filter(Boolean) as string[] },
    { label: "Týmová", blockers: [!card.closureMeeting && "Closure meeting nezaložen", card.closureMeeting && !card.closureMeeting.hankaPosition && "Stanovisko Hanky", card.closureMeeting && !card.closureMeeting.kataPosition && "Stanovisko Káti", card.closureMeeting && !card.closureMeeting.karelFinalStatement && "Karlův statement"].filter(Boolean) as string[] },
    { label: "Operační", blockers: [!cl.relapsePlanExists && "Relapse plán", !cl.groundingWorks && "Grounding nefunguje"].filter(Boolean) as string[] },
  ];
  const hasBackendReadiness = r4 != null;
  const readinessLayers = hasBackendReadiness ? [
    { label: "Klinická", blockers: r4!.clinical.blockers, met: r4!.clinical.met },
    { label: "Procesní", blockers: r4!.process.blockers, met: r4!.process.met },
    { label: "Týmová", blockers: r4!.team.blockers, met: r4!.team.met },
    { label: "Operační", blockers: r4!.operational.blockers, met: r4!.operational.met },
  ] : localLayers.map(l => ({ ...l, met: l.blockers.length === 0 }));
  const readinessMet = readinessLayers.filter(l => l.met).length;
  const readinessPercent = Math.round((readinessMet / 4) * 100);
  const overallReady = hasBackendReadiness ? r4!.overallReady : readinessLayers.every(l => l.met);

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

  return (
    <div className="space-y-4">
      {/* Closure meeting */}
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

      {/* Closure blocker summary */}
      {card.closureBlockerSummary && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          <p className="text-xs font-bold text-amber-800 dark:text-amber-300">Hlavní blocker uzavření</p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{card.closureBlockerSummary}</p>
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
    </div>
  );
};

export default CrisisClosureWorkflow;
