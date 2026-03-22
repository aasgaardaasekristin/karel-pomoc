import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, ClipboardList, Play, Eye } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface CardAnalysisPanelProps {
  clientId: string;
  clientName: string;
  sessions?: any[];
  activePlan?: any;
  pendingTasks?: any[];
  onRequestPlan?: (analysis: any) => void;
}

const CardAnalysisPanel = ({
  clientId,
  clientName,
  sessions,
  activePlan,
  pendingTasks,
  onRequestPlan,
}: CardAnalysisPanelProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [sessionsCount, setSessionsCount] = useState(0);

  const handleAnalyze = async () => {
    setIsLoading(true);
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

  if (!result) {
    return (
      <div className="bg-card rounded-xl border border-border p-6 text-center space-y-4">
        <Search className="w-10 h-10 mx-auto text-muted-foreground/30" />
        <div>
          <h3 className="text-sm font-semibold">Analýza karty — {clientName}</h3>
          <p className="text-xs text-muted-foreground mt-1">Karel projde celou kartu, všechna sezení a vygeneruje komplexní klinický obraz.</p>
        </div>
        <Button onClick={handleAnalyze} disabled={isLoading} className="gap-1.5">
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {isLoading ? "Analyzuji…" : "Analyzuj kartu"}
        </Button>
      </div>
    );
  }

  // Helpers for briefing section
  const truncateSentences = (text: string | null | undefined, max: number) => {
    if (!text) return "—";
    const sentences = text.split(/(?<=\.)\s+/);
    return sentences.slice(0, max).join(" ");
  };

  const lastSession = sessions?.[0];
  const openTasks = pendingTasks?.filter((t) => t.status !== "done") || [];
  const priorityIcon: Record<string, string> = {
    high: "🔴",
    medium: "🟡",
    low: "🟢",
  };

  return (
    <div className="space-y-4">
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

        {/* KDO JE KLIENT */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">KDO JE KLIENT</p>
          <p className="text-sm">{truncateSentences(result.clientProfile, 2)}</p>
        </div>

        {/* SEZENÍ CELKEM */}
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

        {/* MINULÉ SEZENÍ – SHRNUTÍ */}
        {lastSession?.ai_analysis && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">
              MINULÉ SEZENÍ – SHRNUTÍ
            </p>
            <p className="text-sm">{truncateSentences(lastSession.ai_analysis, 3)}</p>
          </div>
        )}

        {/* DIAGNOSTICKÁ HYPOTÉZA */}
        {result.diagnosticHypothesis?.primary && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">
              DIAGNOSTICKÁ HYPOTÉZA
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm">{result.diagnosticHypothesis.primary}</p>
              <Badge
                variant={
                  result.diagnosticHypothesis.confidence === "high"
                    ? "default"
                    : result.diagnosticHypothesis.confidence === "medium"
                      ? "secondary"
                      : "outline"
                }
                className="text-[10px] shrink-0"
              >
                {result.diagnosticHypothesis.confidence === "high"
                  ? "● Vysoká"
                  : result.diagnosticHypothesis.confidence === "medium"
                    ? "● Střední"
                    : "○ Nízká"}
              </Badge>
            </div>
          </div>
        )}

        {/* VHODNÉ TECHNIKY */}
        {result.nextSessionRecommendations?.suggestedTechniques?.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-1">VHODNÉ TECHNIKY</p>
            <div className="flex flex-wrap gap-1.5">
              {result.nextSessionRecommendations.suggestedTechniques.map((t: string, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* CHYBĚJÍCÍ DATA */}
        {result.dataGaps?.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">CHYBĚJÍCÍ DATA</p>
            {result.dataGaps.map((g: string, i: number) => (
              <p key={i} className="text-sm">• {g}</p>
            ))}
          </div>
        )}

        {/* OTEVŘENÉ ÚKOLY */}
        {openTasks.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">OTEVŘENÉ ÚKOLY</p>
            {openTasks.map((t: any, i: number) => (
              <p key={i} className="text-sm">
                {t.task_type === "client_homework"
                  ? "📝"
                  : priorityIcon[t.priority] || "📌"}{" "}
                {t.task}
              </p>
            ))}
          </div>
        )}

        {/* PLÁN SEZENÍ */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">PLÁN SEZENÍ</p>
          {activePlan ? (
            <div className="flex items-center gap-2">
              <span className="text-sm">✅ Vygenerován a schválen</span>
              {onRequestPlan && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] gap-1 px-2"
                  onClick={() => onRequestPlan(result)}
                >
                  <Eye className="w-3 h-3" />
                  Zobrazit
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">⬜ Nevygenerován</span>
              {onRequestPlan && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] gap-1 px-2"
                  onClick={() => onRequestPlan(result)}
                >
                  <ClipboardList className="w-3 h-3" />
                  Sestavit plán
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        {onRequestPlan && (
          <Button onClick={() => onRequestPlan(result)} className="flex-1 gap-1.5" size="sm">
            <ClipboardList className="w-4 h-4" /> Navrhni sezení na základě analýzy
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={handleAnalyze} disabled={isLoading} className="gap-1.5">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Znovu
        </Button>
      </div>
    </div>
  );
};

export default CardAnalysisPanel;
