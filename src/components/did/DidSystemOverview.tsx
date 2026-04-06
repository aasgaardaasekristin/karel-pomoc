import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { syncOverviewTasksToBoard } from "@/lib/parseOverviewTasks";


interface Props {
  refreshTrigger: number;
  onTasksSynced?: () => void;
}

const parseOverviewStream = async (response: Response): Promise<string> => {
  if (!response.body) {
    return (await response.text()).trim();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
        } catch {
          // ignore malformed SSE chunks
        }
      }
    }
  }

  return text.trim();
};

const DidSystemOverview = ({ refreshTrigger, onTasksSynced }: Props) => {
  const [overview, setOverview] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const loadOverview = useCallback(async (manual = false) => {
    if (manual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const headers = await getAuthHeaders();

      // If manual refresh, force context prime first
      if (manual) {
        try {
          await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-context-prime`, {
            method: "POST",
            headers,
            body: JSON.stringify({ forceRefresh: true }),
          });
        } catch (e) {
          console.error("Context prime failed:", e);
        }
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-system-overview`, {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "Karlův přehled se nepodařilo načíst");
      }

      const nextOverview = await parseOverviewStream(response);

      // If empty or contains "čeká na validovaný kontext", try yesterday's context
      if (!nextOverview || nextOverview.includes("čeká na") || nextOverview.includes("validovaný kontext")) {
        // Try loading from did_daily_context for yesterday
        const { supabase } = await import("@/integrations/supabase/client");
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);

        const { data: contextData } = await supabase
          .from("did_daily_context")
          .select("context_json, analysis_json, context_date")
          .in("context_date", [today, yesterday])
          .order("context_date", { ascending: false })
          .limit(1);

        if (contextData?.[0]) {
          const ctx = contextData[0];
          const analysis = ctx.analysis_json as any;
          const dateLabel = ctx.context_date === today ? "dnes" : ctx.context_date;
          setLastUpdated(ctx.context_date !== today ? `Poslední aktualizace: ${new Date(ctx.context_date + "T12:00:00").toLocaleDateString("cs")}` : null);

          if (analysis?.overview || analysis?.briefing) {
            setOverview(analysis.overview || analysis.briefing || JSON.stringify(analysis).slice(0, 500));
          } else if (nextOverview) {
            setOverview(nextOverview);
            setLastUpdated(null);
          }
        } else if (nextOverview) {
          setOverview(nextOverview);
        }
      } else {
        setOverview(nextOverview);
        setLastUpdated(null);
      }

      // Sync tasks from overview to task board
      if (overview) {
        try {
          const synced = await syncOverviewTasksToBoard(overview);
          if (synced > 0) {
            onTasksSynced?.();
          }
        } catch (e) {
          console.warn("Task sync from overview failed:", e);
        }
      }
    } catch (error: any) {
      console.error("Failed to load system overview:", error);
      toast.error(error?.message || "Karlův přehled se nepodařilo načíst");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [overview]);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview, refreshTrigger]);

  return (
    <section className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-primary" />
            Karlův přehled
          </h4>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadOverview(true)}
            disabled={refreshing || loading}
            className="h-7 px-2 text-[0.625rem]"
          >
            {refreshing || loading ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Obnovuji...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1 h-3 w-3" /> Obnovit
              </>
            )}
          </Button>
        </div>
      </div>

      {(loading || refreshing) && (
        <div className="w-full mt-3 h-1 rounded-full bg-primary/10 overflow-hidden">
          <div className="h-full w-1/4 rounded-full bg-primary/60 animate-indeterminate-progress" />
        </div>
      )}

      {loading && !overview ? (
        <div className="mt-2 flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám Karlův přehled...
        </div>
      ) : overview ? (
        <div className={`mt-2 rounded-md border border-border/60 bg-background/40 p-3 ${refreshing ? "opacity-60" : ""}`}>
          <p className="whitespace-pre-line text-[0.6875rem] leading-5 text-foreground">{overview}</p>
        </div>
      ) : null}
    </section>
  );
};

export default DidSystemOverview;
