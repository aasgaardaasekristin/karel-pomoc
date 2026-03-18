import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { syncOverviewTasksToBoard } from "@/lib/parseOverviewTasks";
import DidSessionPrep from "./DidSessionPrep";

interface Props {
  refreshTrigger: number;
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

const DidSystemOverview = ({ refreshTrigger }: Props) => {
  const [overview, setOverview] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useCallback(async (manual = false) => {
    if (manual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-system-overview`, {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || "Karlův přehled se nepodařilo načíst");
      }

      const nextOverview = await parseOverviewStream(response);
      if (!nextOverview) {
        throw new Error("Karlův přehled je prázdný");
      }

      setOverview(nextOverview);
    } catch (error: any) {
      console.error("Failed to load system overview:", error);
      toast.error(error?.message || "Karlův přehled se nepodařilo načíst");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

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
          <p className="mt-1 text-[10px] text-muted-foreground">
            Operativní briefing pro dnešek bez neveřejné interní profilace.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadOverview(true)}
          disabled={refreshing || loading}
          className="h-7 px-2 text-[10px]"
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

      {loading ? (
        <div className="mt-3 flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám Karlův přehled...
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-3">
          <p className="whitespace-pre-line text-[11px] leading-5 text-foreground">{overview}</p>
        </div>
      )}
    </section>
  );
};

export default DidSystemOverview;
