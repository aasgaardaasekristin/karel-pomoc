import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, ClipboardList, Play, RefreshCw, Edit3 } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface SessionPlanPanelProps {
  clientId: string;
  clientName: string;
  analysis?: any;
  onStartSession?: (plan: any) => void;
}

const SessionPlanPanel = ({ clientId, clientName, analysis, onStartSession }: SessionPlanPanelProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [sessionNumber, setSessionNumber] = useState<number | null>(null);
  const [customRequest, setCustomRequest] = useState("");
  const [showCustom, setShowCustom] = useState(false);

  const generatePlan = async (modifications?: string) => {
    setIsLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-plan`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            baseAnalysis: analysis || undefined,
            customRequest: customRequest || undefined,
            modificationsRequested: modifications || undefined,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Chyba ${res.status}`);
      }
      const data = await res.json();
      setPlan(data.plan);
      setSessionNumber(data.sessionNumber);
      setShowCustom(false);
      toast.success("Plán sezení vygenerován");
    } catch (err: any) {
      toast.error(err.message || "Chyba při generování plánu");
    } finally {
      setIsLoading(false);
    }
  };

  if (!plan) {
    return (
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="text-center">
          <ClipboardList className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          <h3 className="text-sm font-semibold">Plán sezení — {clientName}</h3>
          <p className="text-xs text-muted-foreground mt-1">Karel sestaví 60minutový plán s konkrétními technikami a větami.</p>
        </div>

        {showCustom && (
          <Textarea
            placeholder="Na co se chceš zaměřit? (volitelné)"
            value={customRequest}
            onChange={(e) => setCustomRequest(e.target.value)}
            className="min-h-[60px]"
          />
        )}

        <div className="flex gap-2 justify-center">
          <Button onClick={() => generatePlan()} disabled={isLoading} className="gap-1.5">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
            {isLoading ? "Generuji…" : "Navrhni sezení"}
          </Button>
          {!showCustom && (
            <Button variant="outline" size="sm" onClick={() => setShowCustom(true)}>
              <Edit3 className="w-3.5 h-3.5 mr-1" /> Vlastní téma
            </Button>
          )}
        </div>
      </div>
    );
  }

  const phaseColors: Record<string, string> = {
    "Zahájení": "bg-blue-500/10 border-blue-500/20",
    "Hlavní téma": "bg-orange-500/10 border-orange-500/20",
    "Aktivita": "bg-green-500/10 border-green-500/20",
    "Zpracování": "bg-purple-500/10 border-purple-500/20",
    "Uzavření": "bg-muted/30 border-border",
  };

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold">Návrh sezení č. {sessionNumber}</h3>
          <Badge variant="secondary" className="text-xs">60 min</Badge>
        </div>
        <p className="text-sm text-foreground mb-4">{plan.sessionGoal}</p>

        <div className="space-y-3">
          {(plan.phases || []).map((phase: any, i: number) => (
            <div key={i} className={`rounded-lg border p-3 space-y-2 ${phaseColors[phase.name] || "bg-muted/20 border-border"}`}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                  ⏱ {phase.timeStart}–{phase.timeEnd}
                </Badge>
                <span className="text-sm font-semibold">{phase.name}</span>
              </div>

              {phase.technique && <p className="text-xs text-muted-foreground">Technika: {phase.technique}</p>}
              {phase.topic && <p className="text-xs">Téma: {phase.topic}</p>}
              {phase.activityName && <p className="text-xs">Aktivita: {phase.activityName}</p>}

              {(phase.howToStart || phase.clientInstruction || phase.closingPhrase) && (
                <div className="bg-background/50 rounded p-2">
                  <p className="text-xs text-muted-foreground mb-0.5">Řekni:</p>
                  <p className="text-sm italic">"{phase.howToStart || phase.clientInstruction || phase.closingPhrase}"</p>
                </div>
              )}

              {phase.procedure?.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Postup:</p>
                  {phase.procedure.map((s: string, j: number) => (
                    <p key={j} className="text-xs">{j + 1}. {s}</p>
                  ))}
                </div>
              )}

              {phase.supplies?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <span className="text-xs text-muted-foreground">Pomůcky:</span>
                  {phase.supplies.map((s: string, j: number) => (
                    <Badge key={j} variant="outline" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
              )}

              {phase.watchFor?.length > 0 && (
                <p className="text-xs text-muted-foreground">👀 {phase.watchFor.join(", ")}</p>
              )}

              {phase.questions?.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Otázky:</p>
                  {phase.questions.map((q: string, j: number) => (
                    <p key={j} className="text-xs">❓ {q}</p>
                  ))}
                </div>
              )}

              {phase.fallback && (
                <p className="text-xs text-muted-foreground">🔄 Fallback: {phase.fallback}</p>
              )}

              {phase.homeworkForClient && (
                <p className="text-xs">📝 Domácí úkol: {phase.homeworkForClient}</p>
              )}
            </div>
          ))}
        </div>

        {plan.whyThisPlan && (
          <div className="mt-3 p-3 bg-muted/20 rounded-lg">
            <p className="text-xs text-muted-foreground mb-0.5">Proč tento plán:</p>
            <p className="text-sm">{plan.whyThisPlan}</p>
          </div>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        {onStartSession && (
          <Button onClick={() => onStartSession(plan)} className="gap-1.5 flex-1">
            <Play className="w-4 h-4" /> Zahájit asistenci podle plánu
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => generatePlan()} disabled={isLoading} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Jiný návrh
        </Button>
      </div>
    </div>
  );
};

export default SessionPlanPanel;
