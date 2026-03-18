import { useCallback, useEffect, useMemo, useState } from "react";
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
}

const RUNNING_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const DidAgreementsPanel = ({ refreshTrigger = 0, onWeeklyCycleComplete }: { refreshTrigger?: number; onWeeklyCycleComplete?: () => void }) => {
  const [cycles, setCycles] = useState<WeeklyCycleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningWeekly, setRunningWeekly] = useState(false);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);

    const { data } = await supabase
      .from("did_update_cycles")
      .select("id, completed_at, started_at, report_summary, cards_updated, cycle_type, status")
      .eq("cycle_type", "weekly")
      .in("status", ["completed", "running", "failed"])
      .order("created_at", { ascending: false })
      .limit(8);

    if (data) setCycles(data as WeeklyCycleData[]);
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (refreshTrigger > 0) void loadData(true);
  }, [refreshTrigger, loadData]);

  const hasFreshRunning = useMemo(
    () => cycles.some((cycle) => cycle.status === "running" && (Date.now() - new Date(cycle.started_at).getTime()) < RUNNING_TIMEOUT_MS),
    [cycles]
  );

  useEffect(() => {
    if (!hasFreshRunning && !runningWeekly) return;
    const intervalId = window.setInterval(() => {
      void loadData(true);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [hasFreshRunning, runningWeekly, loadData]);

  const handleDeleteCycle = async (cycleId: string) => {
    const { error } = await supabase.from("did_update_cycles").delete().eq("id", cycleId);
    if (error) {
      toast.error("Nepodařilo se smazat záznam");
      return;
    }
    toast.success("Týdenní report smazán");
    void loadData(true);
  };

  const handleRunWeekly = async () => {
    setRunningWeekly(true);
    toast.info("Týdenní cyklus jsem spustil. Průběh teď budu průběžně obnovovat.");

    try {
      const headers = await getAuthHeaders();
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-weekly-cycle`,
        { method: "POST", headers, body: JSON.stringify({ source: "manual" }), signal: controller.signal }
      );

      window.clearTimeout(timeout);

      let result: any = null;
      try {
        result = await resp.json();
      } catch {
        result = null;
      }

      if (!resp.ok) {
        toast.error(`Chyba: ${String(result?.error || "Neznámá chyba").slice(0, 200)}`);
        return;
      }

      if (result?.skipped && result?.reason === "already_running") {
        toast.info("Týdenní cyklus už běží na pozadí.");
      } else if (result?.skipped && result?.reason === "already_completed_recently") {
        toast.info("Týdenní cyklus už proběhl před chvílí, zbytečně ho nespouštím znovu.");
      } else if (result?.skipped && result?.reason === "not_sunday") {
        toast.info("Automatické spuštění z cron je povoleno jen v neděli.");
      } else {
        toast.success(`Týdenní cyklus dokončen. Aktualizováno: ${result?.cardsUpdated?.length || 0} položek.`);
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        toast.info("Týdenní cyklus běží dál na pozadí — nechávám panel průběžně obnovovat.");
      } else {
        toast.error(e.message || "Chyba při spouštění týdenního cyklu");
      }
    } finally {
      setRunningWeekly(false);
      void loadData(true);
      onWeeklyCycleComplete?.();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FileText className="w-3.5 h-3.5 text-primary" />
          Terapeutické dohody & Týdenní analýza
        </h4>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRunWeekly}
          disabled={runningWeekly || hasFreshRunning}
          className="h-6 px-2 text-[10px]"
        >
          {runningWeekly ? (
            <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Spouštím...</>
          ) : hasFreshRunning ? (
            <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Běží...</>
          ) : (
            <><RefreshCw className="w-3 h-3 mr-1" /> Spustit týdenní cyklus</>
          )}
        </Button>
      </div>

      {cycles.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          Zatím neproběhl žádný týdenní cyklus. Spusť ho tlačítkem výše.
        </p>
      ) : (
        cycles.map((cycle) => {
          const cards = Array.isArray(cycle.cards_updated) ? cycle.cards_updated : [];
          const isStaleRunning = cycle.status === "running" && Date.now() - new Date(cycle.started_at).getTime() >= RUNNING_TIMEOUT_MS;
          const visualStatus = isStaleRunning ? "failed" : cycle.status;
          const isRunning = visualStatus === "running";
          const isFailed = visualStatus === "failed";
          const isExpanded = expandedCycle === cycle.id;
          const displayDate = cycle.completed_at || cycle.started_at;
          const statusLabel = isRunning ? "Běží" : isFailed ? "Selhalo" : "Dokončeno";
          const summary = isStaleRunning
            ? "Cyklus se zřejmě zasekl nebo překročil limit. Můžeš ho spustit znovu."
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
                  <div>
                    <span className="text-xs font-medium text-foreground">
                      {isRunning ? "⏳ Probíhá analýza..." : `Týden ${displayDate ? new Date(displayDate).toLocaleDateString("cs-CZ") : "?"}`}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className={`px-1 py-0 text-[9px] ${isFailed ? "border-destructive/40 text-destructive" : isRunning ? "border-primary/30 text-primary" : ""}`}>
                        {isRunning ? <Loader2 className="w-2.5 h-2.5 animate-spin mr-0.5" /> : isFailed ? <AlertCircle className="w-2.5 h-2.5 mr-0.5" /> : null}
                        {statusLabel}
                      </Badge>
                      {!isRunning && !isFailed && (
                        <Badge variant="outline" className="px-1 py-0 text-[9px]">
                          {cards.length} aktualizací
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {!isRunning && <span className="text-[10px] text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>}
                    {!isRunning && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); void handleDeleteCycle(cycle.id); }}
                        className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
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
                        h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold text-foreground first:mt-1">{children}</h2>,
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
