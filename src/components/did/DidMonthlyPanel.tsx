import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, BarChart3, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface MonthlyCycle {
  id: string;
  completed_at: string | null;
  started_at: string;
  report_summary: string | null;
  cards_updated: any;
  status: string;
}

const DidMonthlyPanel = ({ refreshTrigger = 0 }: { refreshTrigger?: number }) => {
  const [cycles, setCycles] = useState<MonthlyCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);
    const { data } = await supabase
      .from("did_update_cycles")
      .select("id, completed_at, started_at, report_summary, cards_updated, status")
      .eq("cycle_type", "monthly")
      .in("status", ["completed", "running"])
      .order("created_at", { ascending: false })
      .limit(3);
    if (data) setCycles(data as MonthlyCycle[]);
    if (!silent) setLoading(false);
  };

  useEffect(() => { loadData(); }, []);
  useEffect(() => { if (refreshTrigger > 0) loadData(true); }, [refreshTrigger]);

  const handleDelete = async (cycleId: string) => {
    const { error } = await supabase.from("did_update_cycles").delete().eq("id", cycleId);
    if (error) { toast.error("Nepodařilo se smazat záznam"); return; }
    toast.success("Měsíční report smazán");
    loadData(true);
  };

  const handleRun = async () => {
    setRunning(true);
    toast.info("Spouštím měsíční analýzu... Může trvat 3-8 minut.");
    try {
      const headers = await getAuthHeaders();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500000);
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-monthly-cycle`,
        { method: "POST", headers, body: JSON.stringify({ source: "manual" }), signal: controller.signal }
      );
      clearTimeout(timeout);
      let result: any = null;
      try { result = await resp.json(); } catch { result = null; }

      if (resp.ok) {
        if (result?.skipped && result?.reason === "cooldown") {
          toast.info("Měsíční cyklus byl spuštěn nedávno. Další spuštění je možné za 25 dní.");
        } else if (result?.skipped) {
          toast.info("Měsíční cyklus přeskočen.");
        } else {
          toast.success(`Měsíční analýza dokončena. Aktualizováno: ${result?.cardsUpdated?.length || 0} dokumentů.`);
        }
      } else {
        toast.error(`Chyba: ${String(result?.error || "Neznámá chyba").slice(0, 200)}`);
      }
    } catch (e: any) {
      if (e.name === "AbortError") toast.info("Analýza pravděpodobně běží na pozadí.");
      else toast.error(e.message || "Chyba při spouštění měsíční analýzy");
    } finally {
      setRunning(false);
      loadData();
    }
  };

  const hasRunning = cycles.some(c => c.status === "running" && Date.now() - new Date(c.started_at).getTime() < 15 * 60 * 1000);

  if (loading) return <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-primary" />
          Měsíční přehledy
        </h4>
        <Button variant="outline" size="sm" onClick={handleRun} disabled={running || hasRunning} className="h-6 text-[10px] px-2">
          {running ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Analyzuji...</> :
           hasRunning ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Běží...</> :
           <><RefreshCw className="w-3 h-3 mr-1" /> Spustit měsíční analýzu</>}
        </Button>
      </div>

      {cycles.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">Zatím žádné měsíční reporty.</p>
      ) : cycles.filter(c => c.status !== "running" || Date.now() - new Date(c.started_at).getTime() < 15 * 60 * 1000).map(cycle => {
        const cards = Array.isArray(cycle.cards_updated) ? cycle.cards_updated : [];
        const isRunning = cycle.status === "running";
        const isExpanded = expandedId === cycle.id;
        const displayDate = cycle.completed_at || cycle.started_at;

        return (
          <div key={cycle.id} className={`rounded-lg border bg-card/50 ${isRunning ? "border-primary/40 animate-pulse" : "border-border"}`}>
            <button
              onClick={() => !isRunning && setExpandedId(isExpanded ? null : cycle.id)}
              className="w-full p-3 text-left hover:bg-muted/30 transition-colors"
              disabled={isRunning}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-foreground">
                    {isRunning ? "⏳ Probíhá analýza..." : `Měsíc ${displayDate ? new Date(displayDate).toLocaleDateString("cs-CZ", { month: "long", year: "numeric" }) : "?"}`}
                  </span>
                  <div className="flex gap-1 mt-1">
                    {!isRunning && <Badge variant="outline" className="text-[9px] px-1 py-0">{cards.length} aktualizací</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {!isRunning && <span className="text-[10px] text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>}
                  {!isRunning && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); handleDelete(cycle.id); }}
                      className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  )}
                </div>
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
                    {cycle.report_summary.slice(0, 5000)}
                  </ReactMarkdown>
                </div>
                {cards.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/30">
                    <p className="text-[10px] text-muted-foreground font-medium mb-1">Aktualizované dokumenty:</p>
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
      })}
    </div>
  );
};

export default DidMonthlyPanel;
