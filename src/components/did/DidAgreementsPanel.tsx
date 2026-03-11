import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface WeeklyCycleData {
  id: string;
  completed_at: string;
  report_summary: string | null;
  cards_updated: any;
  cycle_type: string;
}

const DidAgreementsPanel = () => {
  const [cycles, setCycles] = useState<WeeklyCycleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningWeekly, setRunningWeekly] = useState(false);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("did_update_cycles")
      .select("id, completed_at, report_summary, cards_updated, cycle_type")
      .eq("cycle_type", "weekly")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(10);

    if (data) setCycles(data as WeeklyCycleData[]);
    setLoading(false);
  };

  const handleRunWeekly = async () => {
    setRunningWeekly(true);
    toast.info("Spouštím týdenní analýzu... Může trvat několik minut.");
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-weekly-cycle`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (resp.ok) {
        const result = await resp.json();
        toast.success(`Týdenní cyklus dokončen. Aktualizováno: ${result.cardsUpdated?.length || 0} položek.`);
        loadData();
      } else {
        const err = await resp.text();
        toast.error(`Chyba: ${err.slice(0, 200)}`);
      }
    } catch (e: any) {
      toast.error(e.message || "Chyba při spouštění týdenního cyklu");
    } finally {
      setRunningWeekly(false);
    }
  };

  const extractAgreements = (summary: string | null): string[] => {
    if (!summary) return [];
    const matches = summary.match(/\[DOHODA:\s*(.+?)\]/g);
    if (matches) return matches.map(m => m.replace(/\[DOHODA:\s*/, "").replace(/\]$/, ""));
    // Fallback: look for agreement-like patterns
    const lines = summary.split("\n");
    return lines
      .filter(l => /dohod|agreement|splně|plnění/i.test(l))
      .slice(0, 5)
      .map(l => l.trim().slice(0, 100));
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
          const agreements = cards.filter((c: any) => {
            const s = typeof c === "string" ? c : c?.name || "";
            return /dohod/i.test(s);
          });
          const isExpanded = expandedCycle === cycle.id;

          return (
            <div key={cycle.id} className="rounded-lg border border-border bg-card/50">
              <button
                onClick={() => setExpandedCycle(isExpanded ? null : cycle.id)}
                className="w-full p-3 text-left hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium text-foreground">
                      Týden {cycle.completed_at ? new Date(cycle.completed_at).toLocaleDateString("cs-CZ") : "?"}
                    </span>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {agreements.length > 0 && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          📋 {agreements.length} dohod
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                        {cards.length} aktualizací
                      </Badge>
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {isExpanded ? "▲" : "▼"}
                  </span>
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
