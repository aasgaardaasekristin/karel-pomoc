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
  phase_step: string;
  progress_current: number;
  progress_total: number;
  heartbeat_at: string;
  last_error: string;
}

const computeProgress = (cycle: WeeklyCycleData): number => {
  const { phase } = cycle;
  if (phase === "completed") return 100;
  if (phase === "failed") return 0;
  if (phase === "created") return 5;
  if (phase === "gathering") return 20;
  if (phase === "gathered") return 40;
  if (phase === "analyzing") return 55;
  if (phase === "analyzed") return 70;
  if (phase === "distributing") return 82;
  if (phase === "distributed") return 90;
  if (phase === "notifying") return 95;
  return 5;
};

const PHASE_LABELS: Record<string, string> = {
  created: "Cyklus vytvořen",
  gathering: "Sbírám data...",
  gathered: "Data sebrána",
  analyzing: "AI analyzuje data...",
  analyzed: "Analýza hotová",
  distributing: "Zapisuji do Drive...",
  distributed: "Zápis dokončen",
  notifying: "Odesílám e-maily...",
  completed: "Dokončeno ✓",
  failed: "Selhalo ✗",
};

// Maps: after a phase response, what's the next phase to call
const PHASE_CHAIN: Record<string, string> = {
  created: "gather",
  gathered: "analyze",
  analyzed: "distribute",
  distributed: "notify",
};

const POLL_INTERVAL_MS = 3000;
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
      .select("id, completed_at, started_at, report_summary, cards_updated, cycle_type, status, phase, phase_detail, phase_step, progress_current, progress_total, heartbeat_at, last_error")
      .eq("cycle_type", "weekly")
      .in("status", ["completed", "running", "failed"])
      .order("created_at", { ascending: false })
      .limit(8);
    if (data) setCycles(data as unknown as WeeklyCycleData[]);
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { if (refreshTrigger > 0) void loadData(true); }, [refreshTrigger, loadData]);

  // Clear activeCycleId if the cycle is no longer running
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

  // Strictly serial phase chain: kickoff → gather → analyze → distribute → notify
  // NO auto-advance from polling. NO while loops. Each phase called once, sequentially.
  const runFullCycle = useCallback(async () => {
    if (chainingRef.current) return;
    chainingRef.current = true;

    try {
      toast.info("Týdenní cyklus spuštěn");

      // Step 1: Kickoff
      const kickoffResult = await callPhase("kickoff");
      if (kickoffResult.skipped) {
        if (kickoffResult.cycleId) setActiveCycleId(kickoffResult.cycleId);
        toast.info(kickoffResult.reason === "already_running"
          ? "Jiný týdenní cyklus už právě běží."
          : "Nedávno byl dokončen – zkus to znovu později.");
        void loadData(true);
        return;
      }

      const cid = kickoffResult.cycleId;
      if (!cid) throw new Error("No cycleId from kickoff");
      setActiveCycleId(cid);
      void loadData(true);

      // Step 2: Gather (single call, no loops)
      const gatherResult = await callPhase("gather", cid);
      void loadData(true);
      if (gatherResult.phase !== "gathered") {
        throw new Error(`Gather did not complete: phase=${gatherResult.phase}`);
      }

      // Step 3: Analyze
      await callPhase("analyze", cid);
      void loadData(true);

      // Step 4: Distribute
      await callPhase("distribute", cid);
      void loadData(true);

      // Step 5: Notify
      await callPhase("notify", cid);
      void loadData(true);

      toast.success("Týdenní cyklus dokončen ✓");
      onWeeklyCycleComplete?.();

    } catch (e: any) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        toast.info("Fáze běží na pozadí – panel průběžně obnovuji.");
      } else {
        toast.error(`Chyba: ${e.message?.slice(0, 200) || "Neznámá chyba"}`);
      }
      void loadData(true);
    } finally {
      chainingRef.current = false;
    }
  }, [callPhase, loadData, onWeeklyCycleComplete]);

  const hasRunning = useMemo(
    () => cycles.some((cycle) => cycle.status === "running" && (Date.now() - new Date(cycle.heartbeat_at || cycle.started_at).getTime()) < STALE_TIMEOUT_MS),
    [cycles]
  );

  // Polling when active (display only, never triggers phase calls)
  useEffect(() => {
    if (!activeCycleId && !hasRunning) return;
    const intervalId = window.setInterval(() => void loadData(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [activeCycleId, hasRunning, loadData]);

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
          onClick={runFullCycle}
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
          const heartbeatTime = cycle.heartbeat_at || cycle.started_at;
          const isStale = cycle.status === "running" && Date.now() - new Date(heartbeatTime).getTime() >= STALE_TIMEOUT_MS;
          const visualStatus = isStale ? "failed" : cycle.status;
          const isRunning = visualStatus === "running";
          const isFailed = visualStatus === "failed";
          const isExpanded = expandedCycle === cycle.id;
          const displayDate = cycle.completed_at || cycle.started_at;
          const progress = computeProgress(cycle);
          const phaseLabel = cycle.phase_detail || PHASE_LABELS[cycle.phase] || cycle.phase;
          const summary = isStale
            ? "Cyklus se zřejmě zasekl. Můžeš ho spustit znovu."
            : cycle.report_summary;

          return (
            <div
              key={cycle.id}
              className={`group rounded-lg border bg-card/50 ${isRunning ? "border-primary/40" : isFailed ? "border-destructive/30" : "border-border"}`}
            >
              <div
                role={isRunning ? undefined : "button"}
                tabIndex={isRunning ? undefined : 0}
                onClick={() => !isRunning && setExpandedCycle(isExpanded ? null : cycle.id)}
                onKeyDown={(e) => { if (!isRunning && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setExpandedCycle(isExpanded ? null : cycle.id); } }}
                className={`w-full p-3 text-left transition-colors ${isRunning ? "" : "hover:bg-muted/30 cursor-pointer"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-foreground">
                      {isRunning ? "⏳ Probíhá analýza..." : `Týden ${displayDate ? new Date(displayDate).toLocaleDateString("cs-CZ") : "?"}`}
                    </span>

                    {isRunning && (
                      <div className="mt-2 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span className="truncate max-w-[200px]">{phaseLabel}</span>
                          <span>{progress}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
                          <div
                            className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        {cycle.last_error && (
                          <p className="text-[9px] text-destructive/80 truncate">⚠ {cycle.last_error}</p>
                        )}
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
              </div>

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
