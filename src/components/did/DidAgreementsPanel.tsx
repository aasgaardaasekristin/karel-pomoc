import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, FileText, RefreshCw, AlertCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface WeeklyCycleData {
  id: string;
  completed_at: string | null;
  started_at: string;
  report_summary: string | null;
  cards_updated: any;
  cycle_type: string;
  status: string;
  phase: string;
  phase_detail: string;
}

const PHASE_LABELS: Record<string, string> = {
  created: "Cyklus vytvořen",
  gathering: "Sbírám data z Drive a databáze...",
  gathered: "Data sebrána",
  analyzing: "AI analyzuje data...",
  analyzed: "Analýza hotová",
  distributing: "Zapisuji do Drive...",
  distributed: "Zápis dokončen",
  notifying: "Odesílám e-maily...",
  completed: "Dokončeno ✓",
  failed: "Selhalo ✗",
};

const PHASE_PROGRESS: Record<string, number> = {
  created: 5,
  gathering: 15,
  gathered: 35,
  analyzing: 55,
  analyzed: 72,
  distributing: 84,
  distributed: 94,
  notifying: 97,
  completed: 100,
  failed: 0,
};

const POLL_INTERVAL_MS = 4000;
const STALE_TIMEOUT_MS = 8 * 60 * 1000;

const DidAgreementsPanel = ({ refreshTrigger = 0, onWeeklyCycleComplete }: { refreshTrigger?: number; onWeeklyCycleComplete?: () => void }) => {
  const [cycles, setCycles] = useState<WeeklyCycleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);
  const chainingRef = useRef(false);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const { data } = await supabase
      .from("did_update_cycles")
      .select("id, completed_at, started_at, report_summary, cards_updated, cycle_type, status, phase, phase_detail")
      .eq("cycle_type", "weekly")
      .in("status", ["completed", "running", "failed"])
      .order("created_at", { ascending: false })
      .limit(8);
    if (data) setCycles(data as WeeklyCycleData[]);
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { if (refreshTrigger > 0) void loadData(true); }, [refreshTrigger, loadData]);

  useEffect(() => {
    if (!activeCycleId) return;
    const activeCycle = cycles.find((cycle) => cycle.id === activeCycleId);
    if (!activeCycle || activeCycle.status !== "running") {
      setActiveCycleId(null);
    }
  }, [cycles, activeCycleId]);

  const callPhase = useCallback(async (phase: string, cycleId?: string) => {
    const headers = await getAuthHeaders();
    const body: any = { phase, force: true };
    if (cycleId) body.cycleId = cycleId;

    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-weekly-cycle`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(160000),
    });

    const result = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(result?.error || `Phase ${phase} failed`);
    return result;
  }, []);

  const runPhaseChain = useCallback(async () => {
    if (chainingRef.current) return;
    chainingRef.current = true;

    let currentCycleId: string | null = null;

    try {
      toast.info("Týdenní cyklus spuštěn – fáze 1/5");
      const kickoffResult = await callPhase("kickoff");

      if (kickoffResult.skipped) {
        if (kickoffResult.cycleId) setActiveCycleId(kickoffResult.cycleId);
        toast.info(kickoffResult.reason === "already_running"
          ? "Jiný týdenní cyklus už právě běží. Navazuji na jeho průběh."
          : "Nedávno byl dokončen – zkus to znovu později.");
        void loadData(true);
        return;
      }

      currentCycleId = kickoffResult.cycleId;
      setActiveCycleId(currentCycleId);
      void loadData(true);

      toast.info("Fáze 2/5: Sbírám data z Drive a databáze...");
      await callPhase("gather", currentCycleId);
      void loadData(true);

      toast.info("Fáze 3/5: AI analyzuje data...");
      await callPhase("analyze", currentCycleId);
      void loadData(true);

      toast.info("Fáze 4/5: Zapisuji na Drive a synchronizuji úkoly...");
      await callPhase("distribute", currentCycleId);
      void loadData(true);

      toast.info("Fáze 5/5: Odesílám e-maily...");
      await callPhase("notify", currentCycleId);
      void loadData(true);

      toast.success("Týdenní cyklus úspěšně dokončen! ✅");
      onWeeklyCycleComplete?.();
    } catch (e: any) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        if (currentCycleId) setActiveCycleId(currentCycleId);
        toast.info("Fáze běží na pozadí – panel průběžně obnovuji.");
      } else {
        toast.error(`Chyba: ${e.message?.slice(0, 200) || "Neznámá chyba"}`);
      }
      void loadData(true);
    } finally {
      chainingRef.current = false;
    }
  }, [callPhase, loadData, onWeeklyCycleComplete]);

  useEffect(() => {
    if (!activeCycleId) return;
    const intervalId = window.setInterval(() => void loadData(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [activeCycleId, loadData]);

  const hasRunning = useMemo(
    () => cycles.some((cycle) => cycle.status === "running" && (Date.now() - new Date(cycle.started_at).getTime()) < STALE_TIMEOUT_MS),
    [cycles]
  );

  useEffect(() => {
    if (!hasRunning || activeCycleId) return;
    const intervalId = window.setInterval(() => void loadData(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [hasRunning, activeCycleId, loadData]);

  const handleDeleteCycle = async (cycleId: string) => {
    const { error } = await supabase.from("did_update_cycles").delete().eq("id", cycleId);
    if (error) {
      toast.error("Nepodařilo se smazat záznam");
      return;
    }
    toast.success("Týdenní report smazán");
    void loadData(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-swipe-back-lock={hasRunning || chainingRef.current ? "true" : undefined}>
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FileText className="w-3.5 h-3.5 text-primary" />
          Terapeutické dohody & Týdenní analýza
        </h4>
        <Button
          variant="outline"
          size="sm"
          onClick={runPhaseChain}
          disabled={chainingRef.current || hasRunning}
          className="h-6 px-2 text-[10px]"
        >
          {chainingRef.current || hasRunning ? (
            <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Běží...</>
          ) : (
            <><RefreshCw className="w-3 h-3 mr-1" /> Spustit týdenní cyklus</>
          )}
        </Button>
      </div>

      {cycles.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          Zatím neproběhl žádný týdenní cyklus.
        </p>
      ) : (
        cycles.map((cycle) => {
          const cards = Array.isArray(cycle.cards_updated) ? cycle.cards_updated : [];
          const isStale = cycle.status === "running" && Date.now() - new Date(cycle.started_at).getTime() >= STALE_TIMEOUT_MS;
          const visualStatus = isStale ? "failed" : cycle.status;
          const isRunning = visualStatus === "running";
          const isFailed = visualStatus === "failed";
          const isExpanded = expandedCycle === cycle.id;
          const displayDate = cycle.completed_at || cycle.started_at;
          const progress = PHASE_PROGRESS[cycle.phase] || 0;
          const phaseLabel = cycle.phase_detail || PHASE_LABELS[cycle.phase] || cycle.phase;
          const summary = isStale
            ? "Cyklus se zřejmě zasekl. Můžeš ho spustit znovu."
            : cycle.report_summary;

          return (
            <div
              key={cycle.id}
              className={`group rounded-lg border bg-card/50 ${isRunning ? "border-primary/40" : isFailed ? "border-destructive/30" : "border-border"}`}
            >
              <button
                onClick={() => !isRunning && setExpandedCycle(isExpanded ? null : cycle.id)}
                className="w-full p-3 text-left transition-colors hover:bg-muted/30"
                disabled={isRunning}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-foreground">
                      {isRunning ? "⏳ Probíhá analýza..." : `Týden ${displayDate ? new Date(displayDate).toLocaleDateString("cs-CZ") : "?"}`}
                    </span>

                    {isRunning && (
                      <div className="mt-2 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>{phaseLabel}</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {!isRunning && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className={`px-1 py-0 text-[9px] ${isFailed ? "border-destructive/40 text-destructive" : ""}`}>
                          {isFailed ? <AlertCircle className="w-2.5 h-2.5 mr-0.5" /> : null}
                          {isFailed ? "Selhalo" : "Dokončeno"}
                        </Badge>
                        {!isFailed && (
                          <Badge variant="outline" className="px-1 py-0 text-[9px]">
                            {cards.length} aktualizací
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    {!isRunning && <span className="text-[10px] text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>}
                    {!isRunning && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); void handleDeleteCycle(cycle.id); }}
                        className="h-5 w-5 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
              </button>

              {isExpanded && summary && (
                <div className="border-t border-border/50 px-3 pb-3">
                  <div className="prose prose-sm mt-2 max-w-none text-[11px] leading-relaxed dark:prose-invert">
                    <ReactMarkdown
                      components={{
                        h2: ({ children }) => <h2 className="first:mt-1 mt-3 mb-1 text-sm font-semibold text-foreground">{children}</h2>,
                        h3: ({ children }) => <h3 className="mt-2 mb-0.5 text-xs font-medium text-foreground">{children}</h3>,
                        p: ({ children }) => <p className="mb-1.5 leading-relaxed text-muted-foreground">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                      }}
                    >
                      {summary.slice(0, 3000)}
                    </ReactMarkdown>
                  </div>

                  {cards.length > 0 && (
                    <div className="mt-2 border-t border-border/30 pt-2">
                      <p className="mb-1 text-[10px] font-medium text-muted-foreground">Aktualizované položky:</p>
                      <div className="flex flex-wrap gap-1">
                        {cards.map((card: any, index: number) => (
                          <Badge key={index} variant="secondary" className="px-1 py-0 text-[9px]">
                            {typeof card === "string" ? card : card?.name || "?"}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};

export default DidAgreementsPanel;
