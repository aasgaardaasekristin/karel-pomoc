import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, Activity, Shield, Brain, CheckCircle, Loader2 } from "lucide-react";

interface CrisisEvent {
  id: string;
  part_name: string;
  phase: string;
  severity: string;
  trigger_description: string;
  indicator_emotional_regulation: number;
  indicator_safety: number;
  indicator_coherence: number;
  indicator_trust: number;
  indicator_time_orientation: number;
  diagnostic_score: number | null;
  diagnostic_report: string | null;
  sessions_count: number;
  days_active: number;
  opened_at: string;
  closure_approved_by: string[] | null;
}

interface SessionLog {
  id: string;
  session_date: string;
  session_type: string;
  emotional_regulation_ok: boolean;
  safety_ok: boolean;
  coherence_score: number;
  trust_level: number;
  future_mentions: boolean;
  summary: string | null;
  risk_signals: string[] | null;
  positive_signals: string[] | null;
}

const PHASE_COLORS: Record<string, string> = {
  acute: "bg-destructive text-destructive-foreground",
  stabilizing: "bg-amber-500 text-white",
  diagnostic: "bg-blue-500 text-white",
  closing: "bg-green-500 text-white",
  closed: "bg-muted text-muted-foreground",
};

const PHASE_LABELS: Record<string, string> = {
  acute: "🔴 Akutní",
  stabilizing: "🟠 Stabilizace",
  diagnostic: "🔵 Diagnostika",
  closing: "🟢 Uzavírání",
  closed: "✅ Uzavřeno",
};

export default function DidCrisisPanel({ refreshTrigger }: { refreshTrigger?: number }) {
  const [crises, setCrises] = useState<CrisisEvent[]>([]);
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [selectedCrisis, setSelectedCrisis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [evalLoading, setEvalLoading] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [approveLoading, setApproveLoading] = useState(false);

  const fetchCrises = useCallback(async () => {
    const { data } = await supabase.from("crisis_events").select("*").not("phase", "eq", "closed").order("created_at", { ascending: false });
    if (data) {
      setCrises(data as any[]);
      if (data.length > 0 && !selectedCrisis) setSelectedCrisis(data[0].id);
    }
  }, [selectedCrisis]);

  const fetchLogs = useCallback(async (crisisId: string) => {
    const { data } = await supabase.from("crisis_session_logs").select("*").eq("crisis_id", crisisId).order("session_date", { ascending: false }).limit(20);
    if (data) setLogs(data as any[]);
  }, []);

  useEffect(() => { fetchCrises(); }, [refreshTrigger, fetchCrises]);
  useEffect(() => { if (selectedCrisis) fetchLogs(selectedCrisis); }, [selectedCrisis, fetchLogs]);

  const crisis = crises.find(c => c.id === selectedCrisis);

  const handleEvaluate = async () => {
    if (!selectedCrisis) return;
    setEvalLoading(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/evaluate-crisis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        body: JSON.stringify({ crisisId: selectedCrisis }),
      });
      const data = await res.json();
      if (data.success) { toast.success("Krize přehodnocena"); fetchCrises(); fetchLogs(selectedCrisis); }
      else toast.error(data.error || "Chyba");
    } catch (e) { toast.error(String(e)); }
    setEvalLoading(false);
  };

  const handleDiagnostic = async () => {
    if (!selectedCrisis) return;
    setDiagLoading(true);
    toast.info("Diagnostický rozhovor zatím vyžaduje vlákno s částí.");
    setDiagLoading(false);
  };

  const handleApprove = async (approver: string) => {
    if (!selectedCrisis) return;
    setApproveLoading(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(`https://${projectId}.supabase.co/functions/v1/approve-crisis-closure`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}` },
        body: JSON.stringify({ crisisId: selectedCrisis, approver }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.closed ? "Krize uzavřena!" : `Schváleno: ${approver}`);
        fetchCrises();
      } else toast.error(data.error || "Chyba");
    } catch (e) { toast.error(String(e)); }
    setApproveLoading(false);
  };

  if (crises.length === 0) {
    return <div className="text-center py-6 text-muted-foreground text-xs">Žádné aktivní krize.</div>;
  }

  return (
    <div className="space-y-3">
      {/* Crisis selector if multiple */}
      {crises.length > 1 && (
        <div className="flex gap-1 flex-wrap">
          {crises.map(c => (
            <button key={c.id} onClick={() => setSelectedCrisis(c.id)}
              className={`text-xs px-2 py-1 rounded ${selectedCrisis === c.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {c.part_name}
            </button>
          ))}
        </div>
      )}

      {crisis && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-foreground">{crisis.part_name}</p>
              <p className="text-[10px] text-muted-foreground">{crisis.trigger_description?.slice(0, 100)}</p>
            </div>
            <Badge className={PHASE_COLORS[crisis.phase] || "bg-muted"}>
              {PHASE_LABELS[crisis.phase] || crisis.phase}
            </Badge>
          </div>

          <div className="flex gap-3 text-[10px] text-muted-foreground">
            <span>Dní: <strong className="text-foreground">{crisis.days_active}</strong></span>
            <span>Sezení: <strong className="text-foreground">{crisis.sessions_count}</strong></span>
            <span>Severity: <strong className={crisis.severity === "critical" ? "text-destructive" : "text-foreground"}>{crisis.severity}</strong></span>
          </div>

          {/* Indicators */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium text-muted-foreground">Indikátory</p>
            {[
              { label: "Emoční regulace", value: crisis.indicator_emotional_regulation, icon: Activity },
              { label: "Bezpečnost", value: crisis.indicator_safety, icon: Shield },
              { label: "Koherence", value: crisis.indicator_coherence, icon: Brain },
              { label: "Důvěra", value: crisis.indicator_trust, icon: Shield },
              { label: "Čas. orientace", value: crisis.indicator_time_orientation, icon: Activity },
            ].map(ind => (
              <div key={ind.label} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-24 shrink-0">{ind.label}</span>
                <Progress value={ind.value * 10} className="h-1.5 flex-1" />
                <span className="text-[10px] font-mono w-6 text-right text-foreground">{ind.value}</span>
              </div>
            ))}
          </div>

          {/* Diagnostic report */}
          {crisis.diagnostic_score !== null && (
            <div className="bg-muted/50 rounded-lg p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium text-foreground">Diagnostický report</p>
                <Badge variant="outline" className="text-[9px]">{crisis.diagnostic_score}/100</Badge>
              </div>
              <Progress value={crisis.diagnostic_score} className="h-2" />
              {crisis.diagnostic_report && (
                <p className="text-[10px] text-muted-foreground">{crisis.diagnostic_report.slice(0, 200)}</p>
              )}
            </div>
          )}

          {/* Timeline */}
          {logs.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">Timeline</p>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {logs.map(log => (
                  <div key={log.id} className="flex items-start gap-2 text-[10px]">
                    <span className="text-muted-foreground shrink-0 w-14">
                      {new Date(log.session_date).toLocaleDateString("cs")}
                    </span>
                    <span className={log.session_type === "diagnostic" ? "text-blue-600" : "text-foreground"}>
                      {log.session_type === "diagnostic" ? "🧪 Diagnostika" : "💬 Sezení"}
                    </span>
                    <span className="text-muted-foreground">
                      {log.safety_ok ? "✅" : "⚠️"} bezpečnost
                      {log.session_type === "diagnostic" && log.scaling_score !== null && ` · Skóre: ${log.scaling_score}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={handleEvaluate} disabled={evalLoading}>
              {evalLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Přehodnotit
            </Button>

            {crisis.phase === "diagnostic" && (
              <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={handleDiagnostic} disabled={diagLoading}>
                {diagLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                Spustit diagnostiku
              </Button>
            )}

            {crisis.phase === "closing" && (
              <>
                <Button size="sm" className="h-7 text-[10px] gap-1 bg-green-600 hover:bg-green-700" onClick={() => handleApprove("hanka")} disabled={approveLoading || (crisis.closure_approved_by || []).includes("hanka")}>
                  {approveLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                  Schválit (Hanka)
                </Button>
                <Button size="sm" className="h-7 text-[10px] gap-1 bg-green-600 hover:bg-green-700" onClick={() => handleApprove("kata")} disabled={approveLoading || (crisis.closure_approved_by || []).includes("kata")}>
                  {approveLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                  Schválit (Káťa)
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
