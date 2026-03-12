import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, FileText, RefreshCw, AlertCircle } from "lucide-react";
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

const DidAgreementsPanel = () => {
  const [cycles, setCycles] = useState<WeeklyCycleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningWeekly, setRunningWeekly] = useState(false);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    const intervalId = window.setInterval(() => {
      loadData();
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, []);

  const loadData = async () => {
    setLoading(true);

    // Auto-cleanup: mark stuck "running" cycles older than 10 min as "failed"
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase
      .from("did_update_cycles")
      .update({ status: "failed", completed_at: new Date().toISOString(), report_summary: "Automaticky označeno jako neúspěšné (timeout)." })
      .eq("status", "running")
      .lt("started_at", tenMinAgo);

    const { data } = await supabase
      .from("did_update_cycles")
      .select("id, completed_at, started_at, report_summary, cards_updated, cycle_type, status")
      .eq("cycle_type", "weekly")
      .in("status", ["completed", "running", "failed"])
      .order("created_at", { ascending: false })
      .limit(10);

    if (data) setCycles(data as WeeklyCycleData[]);
    setLoading(false);
  };

  const handleRunWeekly = async () => {
    setRunningWeekly(true);
    toast.info("Spouštím týdenní analýzu... Může trvat 2-5 minut.");
    try {
      const headers = await getAuthHeaders();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 280000); // 280s timeout
      
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-weekly-cycle`,
        { method: "POST", headers, body: JSON.stringify({}), signal: controller.signal }
      );
      clearTimeout(timeout);
      
      if (resp.ok) {
        const result = await resp.json();
        toast.success(`Týdenní cyklus dokončen. Aktualizováno: ${result.cardsUpdated?.length || 0} položek.`);
      } else {
        const err = await resp.text();
        toast.error(`Chyba: ${err.slice(0, 200)}`);
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        toast.info("Cyklus pravděpodobně stále běží na pozadí. Obnovte stránku za chvíli.");
      } else {
        toast.error(e.message || "Chyba při spouštění týdenního cyklu");
      }
    } finally {
      setRunningWeekly(false);
      loadData();
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
      {/* Run weekly button */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-primary" />
          Terapeutické dohody & Týdenní analýzy
        </h4>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRunWeekly}
          disabled={runningWeekly}
          className="h-6 text-[10px] px-2"
        >
          {runningWeekly ? (
            <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Analyzuji...</>
          ) : (
            <><RefreshCw className="w-3 h-3 mr-1" /> Spustit týdenní cyklus</>
          )}
        </Button>
      </div>

      {cycles.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          Zatím neproběhl žádný týdenní cyklus. Spusť ho tlačítkem výše.
        </p>
      ) : (
        cycles.map(cycle => {
          const cards = Array.isArray(cycle.cards_updated) ? cycle.cards_updated : [];
          const isRunning = cycle.status === "running";
          const isExpanded = expandedCycle === cycle.id;
          const displayDate = cycle.completed_at || cycle.started_at;

          return (
            <div key={cycle.id} className={`rounded-lg border bg-card/50 ${isRunning ? "border-primary/40 animate-pulse" : "border-border"}`}>
              <button
                onClick={() => !isRunning && setExpandedCycle(isExpanded ? null : cycle.id)}
                className="w-full p-3 text-left hover:bg-muted/30 transition-colors"
                disabled={isRunning}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium text-foreground">
                      {isRunning ? "⏳ Probíhá analýza..." : `Týden ${displayDate ? new Date(displayDate).toLocaleDateString("cs-CZ") : "?"}`}
                    </span>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {isRunning ? (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/30 text-primary">
                          <Loader2 className="w-2.5 h-2.5 animate-spin mr-0.5" /> Běží...
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          {cards.length} aktualizací
                        </Badge>
                      )}
                    </div>
                  </div>
                  {!isRunning && (
                    <span className="text-[10px] text-muted-foreground">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  )}
                </div>
              </button>

              {isExpanded && cycle.report_summary && (
                <div className="px-3 pb-3 border-t border-border/50">
                  <div className="mt-2 prose prose-sm dark:prose-invert max-w-none text-[11px] leading-relaxed">
                    <ReactMarkdown
                      components={{
                        h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1 first:mt-1">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-xs font-medium text-foreground mt-2 mb-0.5">{children}</h3>,
                        p: ({ children }) => <p className="text-muted-foreground mb-1.5 leading-relaxed">{children}</p>,
                        strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
                      }}
                    >
                      {cycle.report_summary.slice(0, 3000)}
                    </ReactMarkdown>
                  </div>
                  {cards.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/30">
                      <p className="text-[10px] text-muted-foreground font-medium mb-1">Aktualizované položky:</p>
                      <div className="flex flex-wrap gap-1">
                        {cards.map((c: any, i: number) => (
                          <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">
                            {typeof c === "string" ? c : c?.name || "?"}
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
