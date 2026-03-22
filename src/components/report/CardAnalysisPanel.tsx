import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Loader2, Search, ClipboardList, Eye, Check, Edit3 } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface CardAnalysisPanelProps {
  clientId: string;
  clientName: string;
  sessions?: any[];
  activePlan?: any;
  pendingTasks?: any[];
  onRequestPlan?: (analysis: any) => void;
  existingTherapyPlan?: string;
  onPlanSaved?: (plan: string) => void;
}

const ANALYSIS_STEPS = [
  "Čtu kartu klienta...",
  "Analyzuji sezení...",
  "Konzultuji odborné zdroje...",
  "Sestavuji klinický obraz...",
];

const PLAN_STEPS = [
  "Načítám data klienta...",
  "Konzultuji výzkumné zdroje...",
  "Sestavuji terapeutický plán...",
  "Finalizuji doporučení...",
];

type PlanState = "idle" | "generating" | "review" | "saving" | "saved";

const CardAnalysisPanel = ({
  clientId,
  clientName,
  sessions,
  activePlan,
  pendingTasks,
  onRequestPlan,
  existingTherapyPlan,
  onPlanSaved,
}: CardAnalysisPanelProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [sessionsCount, setSessionsCount] = useState(0);

  // Plan state
  const [planState, setPlanState] = useState<PlanState>("idle");
  const [planContent, setPlanContent] = useState("");
  const [planStep, setPlanStep] = useState(0);
  const [modifications, setModifications] = useState("");

  // Rotate analysis step messages
  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setAnalysisStep((p) => (p + 1) % ANALYSIS_STEPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isLoading]);

  // Rotate plan step messages
  useEffect(() => {
    if (planState !== "generating") return;
    const interval = setInterval(() => {
      setPlanStep((p) => (p + 1) % PLAN_STEPS.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [planState]);

  const handleAnalyze = async () => {
    setIsLoading(true);
    setAnalysisStep(0);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-card-analysis`,
        { method: "POST", headers, body: JSON.stringify({ clientId }) }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Chyba ${res.status}`);
      }
      const data = await res.json();
      setResult(data.result);
      setSessionsCount(data.sessionsCount || 0);
      toast.success("Analýza karty dokončena");
    } catch (err: any) {
      toast.error(err.message || "Chyba při analýze");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGeneratePlan = async (mods?: string) => {
    setPlanState("generating");
    setPlanStep(0);
    setPlanContent("");

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-therapy-process-plan`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            cardAnalysis: result,
            modifications: mods || undefined,
          }),
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Chyba ${res.status}`);
      }

      // Stream SSE
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              setPlanContent(fullText);
            }
          } catch {}
        }
      }

      setPlanState("review");
    } catch (err: any) {
      toast.error(err.message || "Chyba při generování plánu");
      setPlanState("idle");
    }
  };

  const handleSavePlan = async () => {
    setPlanState("saving");
    try {
      // Save to DB
      const { error } = await supabase
        .from("clients")
        .update({ therapy_plan: planContent } as any)
        .eq("id", clientId);
      if (error) throw new Error(error.message);

      // Drive backup fire-and-forget
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        supabase.functions.invoke("karel-session-drive-backup", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: {
            mode: "therapy-plan",
            clientId,
            content: planContent,
          },
        }).catch(() => {});
      }

      onPlanSaved?.(planContent);
      setPlanState("saved");
      toast.success("Terapeutický plán uložen do karty klienta");
    } catch (err: any) {
      toast.error(err.message || "Chyba při ukládání");
      setPlanState("review");
    }
  };

  // ── Loading state (no result yet) ──
  if (!result) {
    return (
      <div className="bg-card rounded-xl border border-border p-6 text-center space-y-4">
        {isLoading ? (
          <>
            <div className="space-y-3">
              <Loader2 className="w-8 h-8 mx-auto animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground animate-pulse">
                {ANALYSIS_STEPS[analysisStep]}
              </p>
              <div className="max-w-xs mx-auto">
                <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full animate-indeterminate-progress" 
                       style={{ width: "40%" }} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Může to trvat 15-30 sekund</p>
            </div>
          </>
        ) : (
          <>
            <Search className="w-10 h-10 mx-auto text-muted-foreground/30" />
            <div>
              <h3 className="text-sm font-semibold">Analýza karty — {clientName}</h3>
              <p className="text-xs text-muted-foreground mt-1">Karel projde celou kartu, všechna sezení a vygeneruje komplexní klinický obraz.</p>
            </div>
            <Button onClick={handleAnalyze} className="gap-1.5">
              <Search className="w-4 h-4" />
              Analyzuj kartu
            </Button>
          </>
        )}
      </div>
    );
  }

  // Helpers
  const truncateSentences = (text: string | null | undefined, max: number) => {
    if (!text) return "—";
    const sentences = text.split(/(?<=\.)\s+/);
    return sentences.slice(0, max).join(" ");
  };

  const lastSession = sessions?.[0];
  const openTasks = pendingTasks?.filter((t) => t.status !== "done") || [];
  const priorityIcon: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

  const hasPlan = existingTherapyPlan || planState === "saved";

  return (
    <div className="space-y-4">
      {/* Loading overlay for re-analysis */}
      {isLoading && (
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium animate-pulse">{ANALYSIS_STEPS[analysisStep]}</p>
            <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden mt-2">
              <div className="h-full bg-primary rounded-full" 
                   style={{ width: "40%", animation: "indeterminate 1.5s ease-in-out infinite" }} />
            </div>
          </div>
        </div>
      )}

      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Analýza karty — {clientName}</h3>
          <Badge variant="secondary" className="text-xs">{sessionsCount} sezení</Badge>
        </div>

        <Tabs defaultValue="profile" className="space-y-3">
          <TabsList className="grid w-full grid-cols-3 h-8">
            <TabsTrigger value="profile" className="text-xs">Profil</TabsTrigger>
            <TabsTrigger value="diagnosis" className="text-xs">Diagnostika</TabsTrigger>
            <TabsTrigger value="next" className="text-xs">Co příště</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>{result.clientProfile || "—"}</ReactMarkdown>
            {result.therapeuticProgress && (
              <div className="mt-3 space-y-2 not-prose">
                {result.therapeuticProgress.whatWorks?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">✅ Co funguje:</p>
                    {result.therapeuticProgress.whatWorks.map((w: string, i: number) => (
                      <p key={i} className="text-sm">• {w}</p>
                    ))}
                  </div>
                )}
                {result.therapeuticProgress.whatDoesntWork?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">❌ Co nefunguje:</p>
                    {result.therapeuticProgress.whatDoesntWork.map((w: string, i: number) => (
                      <p key={i} className="text-sm">• {w}</p>
                    ))}
                  </div>
                )}
                {result.therapeuticProgress.clientDynamics && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Dynamika:</p>
                    <p className="text-sm">{result.therapeuticProgress.clientDynamics}</p>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="diagnosis" className="space-y-3">
            {result.diagnosticHypothesis && (
              <>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Primární hypotéza:</p>
                  <p className="text-sm font-medium">{result.diagnosticHypothesis.primary || "—"}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">Jistota:</span>
                    <Badge variant={
                      result.diagnosticHypothesis.confidence === "high" ? "default" :
                      result.diagnosticHypothesis.confidence === "medium" ? "secondary" : "outline"
                    } className="text-xs">
                      {result.diagnosticHypothesis.confidence === "high" ? "● Vysoká" :
                       result.diagnosticHypothesis.confidence === "medium" ? "● Střední" : "○ Nízká"}
                    </Badge>
                  </div>
                </div>
                {result.diagnosticHypothesis.differential?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Diferenciální dg.:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {result.diagnosticHypothesis.differential.map((d: string, i: number) => (
                        <Badge key={i} variant="outline" className="text-xs">{d}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {result.diagnosticHypothesis.supportingEvidence?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Podpůrné důkazy:</p>
                    {result.diagnosticHypothesis.supportingEvidence.map((e: string, i: number) => (
                      <p key={i} className="text-sm">• {e}</p>
                    ))}
                  </div>
                )}
              </>
            )}
            {result.dataGaps?.length > 0 && (
              <div className="p-3 bg-destructive/5 rounded-lg">
                <p className="text-xs font-semibold text-destructive mb-1">Chybějící data:</p>
                {result.dataGaps.map((g: string, i: number) => (
                  <p key={i} className="text-sm">• {g}</p>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="next" className="space-y-3">
            {result.nextSessionRecommendations && (
              <>
                {result.nextSessionRecommendations.focus?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Zaměření:</p>
                    {result.nextSessionRecommendations.focus.map((f: string, i: number) => (
                      <p key={i} className="text-sm">• {f}</p>
                    ))}
                  </div>
                )}
                {result.nextSessionRecommendations.suggestedTechniques?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Techniky:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {result.nextSessionRecommendations.suggestedTechniques.map((t: string, i: number) => (
                        <Badge key={i} variant="secondary" className="text-xs">{t}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {result.nextSessionRecommendations.diagnosticTests?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Doporučené testy:</p>
                    {result.nextSessionRecommendations.diagnosticTests.map((t: string, i: number) => (
                      <p key={i} className="text-sm">• {t}</p>
                    ))}
                  </div>
                )}
                {result.nextSessionRecommendations.thingsToAsk?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Otázky k položení:</p>
                    {result.nextSessionRecommendations.thingsToAsk.map((q: string, i: number) => (
                      <p key={i} className="text-sm">❓ {q}</p>
                    ))}
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ═══ PŘEHLED PŘED SEZENÍM ═══ */}
      <div className="bg-card rounded-xl border-2 border-primary/20 p-4 space-y-4">
        <div className="border-b border-border pb-2">
          <h3 className="text-sm font-bold tracking-wide">
            PŘEHLED PŘED SEZENÍM č. {sessions?.length ? sessions.length + 1 : "?"} – {clientName}
          </h3>
          <p className="text-[10px] text-muted-foreground">
            Sestaveno: {new Date().toLocaleDateString("cs-CZ")}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">KDO JE KLIENT</p>
          <p className="text-sm">{truncateSentences(result.clientProfile, 2)}</p>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span>
            <span className="text-muted-foreground text-xs">SEZENÍ CELKEM:</span>{" "}
            <span className="font-medium">{sessionsCount}</span>
          </span>
          {lastSession && (
            <>
              <span className="text-muted-foreground">│</span>
              <span>
                <span className="text-muted-foreground text-xs">Poslední:</span>{" "}
                <span className="font-medium">
                  {new Date(lastSession.session_date).toLocaleDateString("cs-CZ")}
                </span>
              </span>
            </>
          )}
        </div>

        {lastSession?.ai_analysis && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">MINULÉ SEZENÍ – SHRNUTÍ</p>
            <p className="text-sm">{truncateSentences(lastSession.ai_analysis, 3)}</p>
          </div>
        )}

        {result.diagnosticHypothesis?.primary && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">DIAGNOSTICKÁ HYPOTÉZA</p>
            <div className="flex items-center gap-2">
              <p className="text-sm">{result.diagnosticHypothesis.primary}</p>
              <Badge variant={
                result.diagnosticHypothesis.confidence === "high" ? "default" :
                result.diagnosticHypothesis.confidence === "medium" ? "secondary" : "outline"
              } className="text-[10px] shrink-0">
                {result.diagnosticHypothesis.confidence === "high" ? "● Vysoká" :
                 result.diagnosticHypothesis.confidence === "medium" ? "● Střední" : "○ Nízká"}
              </Badge>
            </div>
          </div>
        )}

        {result.nextSessionRecommendations?.suggestedTechniques?.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-1">VHODNÉ TECHNIKY</p>
            <div className="flex flex-wrap gap-1.5">
              {result.nextSessionRecommendations.suggestedTechniques.map((t: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">{t}</Badge>
              ))}
            </div>
          </div>
        )}

        {result.dataGaps?.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">CHYBĚJÍCÍ DATA</p>
            {result.dataGaps.map((g: string, i: number) => (
              <p key={i} className="text-sm">• {g}</p>
            ))}
          </div>
        )}

        {openTasks.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">OTEVŘENÉ ÚKOLY</p>
            {openTasks.map((t: any, i: number) => (
              <p key={i} className="text-sm">
                {t.task_type === "client_homework" ? "📝" : priorityIcon[t.priority] || "📌"}{" "}
                {t.task}
              </p>
            ))}
          </div>
        )}

        {/* TERAPEUTICKÝ PLÁN PROCESU */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">TERAPEUTICKÝ PLÁN PROCESU</p>
          {hasPlan ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">✅ Sestavený a schválený</span>
              <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 px-2"
                onClick={() => handleGeneratePlan()}>
                <Edit3 className="w-3 h-3" /> Aktualizovat
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">⬜ Nevygenerován</span>
              <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 px-2"
                onClick={() => handleGeneratePlan()}
                disabled={planState === "generating"}>
                <ClipboardList className="w-3 h-3" /> Sestavit plán procesu
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ═══ PLAN GENERATION / REVIEW ═══ */}
      {planState === "generating" && (
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
            <p className="text-sm font-medium animate-pulse">{PLAN_STEPS[planStep]}</p>
          </div>
          <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full"
                 style={{ width: "40%", animation: "indeterminate 1.5s ease-in-out infinite" }} />
          </div>
          {planContent && (
            <div className="mt-3 max-h-60 overflow-y-auto bg-background/50 rounded-lg p-3 prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{planContent}</ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {(planState === "review" || planState === "saving") && (
        <div className="bg-card rounded-xl border-2 border-primary/30 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">📋 Terapeutický plán procesu – návrh</h3>
            <Badge variant="outline" className="text-xs">K revizi</Badge>
          </div>

          <div className="max-h-96 overflow-y-auto bg-background/50 rounded-lg p-4 prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown>{planContent}</ReactMarkdown>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Chceš provést úpravy? Napiš požadavky:</p>
            <Textarea
              value={modifications}
              onChange={(e) => setModifications(e.target.value)}
              placeholder="Např.: Přidej více projektivních technik, zaměř se víc na rodinnou dynamiku..."
              className="min-h-[60px] text-sm"
            />
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5"
              disabled={!modifications.trim() || planState === "saving"}
              onClick={() => {
                const mods = modifications;
                setModifications("");
                handleGeneratePlan(mods);
              }}>
              <Edit3 className="w-3.5 h-3.5" /> Požádat o úpravy
            </Button>
            <Button size="sm" className="gap-1.5 flex-1"
              disabled={planState === "saving"}
              onClick={handleSavePlan}>
              {planState === "saving" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              {planState === "saving" ? "Ukládám..." : "Schválit a uložit do karty"}
            </Button>
          </div>
        </div>
      )}

      {planState === "saved" && (
        <div className="bg-primary/10 border border-primary/30 rounded-xl p-4 flex items-center gap-3">
          <Check className="w-5 h-5 text-primary shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Plán uložen do karty klienta</p>
            <p className="text-xs text-muted-foreground">Záloha na Drive probíhá na pozadí</p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button onClick={() => handleGeneratePlan()} className="flex-1 gap-1.5" size="sm"
          disabled={planState === "generating"}>
          <ClipboardList className="w-4 h-4" /> Sestavit terapeutický plán procesu
        </Button>
        <Button variant="outline" size="sm" onClick={handleAnalyze} disabled={isLoading} className="gap-1.5">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Znovu
        </Button>
      </div>
    </div>
  );
};

export default CardAnalysisPanel;
