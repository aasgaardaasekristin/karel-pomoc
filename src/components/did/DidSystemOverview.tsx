import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { syncOverviewTasksToBoard } from "@/lib/parseOverviewTasks";

interface Props {
  refreshTrigger: number;
  onTasksSynced?: () => void;
}

/** FÁZE 3B architektura komponenty:
 *  - server (karel-did-context-prime / karel-did-system-overview) je jediná autorita
 *  - tato komponenta je pouze čtečka kanonického snapshotu z `did_daily_context`
 *  - `extractOverviewText` je čistý SYNC selektor — žádné živé DB dotazy
 *  - `buildEmergencyFallback` je oddělená nouzová větev pro stav, kdy snapshot vůbec neexistuje */

/** Prague-day ISO (YYYY-MM-DD) — sjednoceno s ostatními callsites Phase 2C/3 */
const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

/** EMERGENCY FALLBACK — spouští se jen když v `did_daily_context` není snapshot.
 *  Není to druhý frontend resolver mozek; je to last-resort, aby UI nebylo prázdné.
 *  Crisis count = kanonický `crisis_events` (open phases), ne `crisis_alerts`. */
const buildEmergencyFallback = async (): Promise<string | null> => {
  try {
    const [crisisRes, planItemsRes, manualTasksRes, questionsRes, sessionsRes] = await Promise.all([
      // CANONICAL: crisis_events with open phases
      supabase.from("crisis_events").select("id", { count: "exact", head: true }).not("phase", "in", '("closed","CLOSED")'),
      supabase.from("did_plan_items").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabase.from("did_therapist_tasks").select("id", { count: "exact", head: true }).eq("status", "pending").is("plan_item_id", null),
      supabase.from("did_pending_questions").select("id", { count: "exact", head: true }).in("status", ["pending", "sent"]),
      supabase.from("did_daily_session_plans").select("id", { count: "exact", head: true }).eq("status", "planned"),
    ]);

    const crisis = crisisRes.count ?? 0;
    const planItems = planItemsRes.count ?? 0;
    const manualTasks = manualTasksRes.count ?? 0;
    const questions = questionsRes.count ?? 0;
    const sessions = sessionsRes.count ?? 0;

    return `Karlův přehled (bez denní analýzy):\n🔴 Aktivní krize: ${crisis} | 📝 Akce (Karel/manuální): ${planItems}/${manualTasks} | ❓ Otázky: ${questions} | 🎯 Sezení: ${sessions}`;
  } catch (e) {
    console.warn("Emergency fallback query failed:", e);
    return null;
  }
};

/** Load the latest record from did_daily_context */
const loadLatestContext = async () => {
  const { data } = await supabase
    .from("did_daily_context")
    .select("context_json, analysis_json, context_date")
    .order("context_date", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
};

/** Extract display text from a context record.
 *  FÁZE 3B: čistý SYNC selektor nad kanonickým snapshotem.
 *  - žádné živé DB dotazy (žádný druhý frontend resolver mozek)
 *  - žádný `crisis_alerts` jako pravda
 *  - jen kanonická pole z `analysis_json` / `context_json` ze serveru */
const extractOverviewText = (ctx: { analysis_json: any; context_json: any }): string | null => {
  const analysis = ctx.analysis_json as any;
  if (analysis?.overview) return analysis.overview;
  if (analysis?.briefing) return analysis.briefing;

  const cj = ctx.context_json as any;
  if (!cj) return null;

  const parts: string[] = [];

  const crisisCount =
    typeof cj.canonical_crisis_count === "number"
      ? cj.canonical_crisis_count
      : Array.isArray(cj?.command?.crises)
        ? cj.command.crises.length
        : Array.isArray(cj?.crises)
          ? cj.crises.length
          : null;
  if (typeof crisisCount === "number" && crisisCount > 0) {
    parts.push(`🔴 Krize: ${crisisCount}`);
  }

  const activePartsCount =
    Array.isArray(cj?.parts?.active)
      ? cj.parts.active.length
      : Array.isArray(cj?.active_parts)
        ? cj.active_parts.length
        : null;
  if (typeof activePartsCount === "number" && activePartsCount > 0) {
    parts.push(`👥 Aktivní části: ${activePartsCount}`);
  }

  const queueCount =
    Array.isArray(cj?.command?.queue?.primary) || Array.isArray(cj?.command?.queue?.adjunct)
      ? (cj.command.queue.primary?.length || 0) + (cj.command.queue.adjunct?.length || 0)
      : Array.isArray(cj?.pending_tasks)
        ? cj.pending_tasks.length
        : null;
  if (typeof queueCount === "number" && queueCount > 0) {
    parts.push(`📝 Úkoly: ${queueCount}`);
  }

  return parts.length ? parts.join(" | ") : null;
};

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
  const [forcingAnalysis, setForcingAnalysis] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const today = pragueDayISO();

  /** QUICK REFRESH — loads from did_daily_context only, no edge function calls */
  const quickRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const ctx = await loadLatestContext();
      if (ctx) {
        const text = extractOverviewText(ctx);
        if (text) {
          setOverview(text);
          setLastUpdated(ctx.context_date !== today ? `Poslední aktualizace: ${new Date(ctx.context_date + "T12:00:00").toLocaleDateString("cs")}` : null);
          // Sync tasks
          try {
            const synced = await syncOverviewTasksToBoard(text);
            if (synced > 0) onTasksSynced?.();
          } catch {}
          return;
        }
      }
      // No context at all — emergency fallback
      const fallback = await buildEmergencyFallback();
      if (fallback) {
        setOverview(fallback);
        setLastUpdated("Bez denní analýzy");
      }
    } catch (e: any) {
      console.error("Quick refresh failed:", e);
      toast.error("Nepodařilo se obnovit přehled");
    } finally {
      setRefreshing(false);
    }
  }, [today, onTasksSynced]);

  /** FORCE ANALYSIS — calls context-prime with 30s timeout, falls back to DB */
  const forceAnalysis = useCallback(async () => {
    setForcingAnalysis(true);
    try {
      const headers = await getAuthHeaders();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-context-prime`, {
          method: "POST",
          headers,
          body: JSON.stringify({ forceRefresh: true }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (e.name === "AbortError") {
          console.warn("Context prime timed out after 30s, using DB fallback");
        } else {
          console.error("Context prime failed:", e);
        }
      }

      // After prime (or timeout), load from DB
      await quickRefresh();
      toast.success("Analýza dokončena");
    } catch (e: any) {
      console.error("Force analysis failed:", e);
      toast.error("Analýza selhala");
    } finally {
      setForcingAnalysis(false);
    }
  }, [quickRefresh]);

  /** INITIAL LOAD — try system-overview with 30s timeout, fallback to DB */
  const initialLoad = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let nextOverview = "";
      try {
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-system-overview`, {
          method: "POST",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          nextOverview = await parseOverviewStream(response);
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (e.name === "AbortError") {
          console.warn("System overview timed out after 30s, using DB fallback");
        } else {
          console.error("System overview fetch failed:", e);
        }
      }

      // Good response — use it
      if (nextOverview && !nextOverview.includes("čeká na") && !nextOverview.includes("validovaný kontext")) {
        setOverview(nextOverview);
        setLastUpdated(null);
        try {
          const synced = await syncOverviewTasksToBoard(nextOverview);
          if (synced > 0) onTasksSynced?.();
        } catch {}
        return;
      }

      // Fallback to DB
      const ctx = await loadLatestContext();
      if (ctx) {
        const text = extractOverviewText(ctx);
        if (text) {
          setOverview(text);
          setLastUpdated(ctx.context_date !== today ? `Poslední aktualizace: ${new Date(ctx.context_date + "T12:00:00").toLocaleDateString("cs")}` : null);
          try {
            const synced = await syncOverviewTasksToBoard(text);
            if (synced > 0) onTasksSynced?.();
          } catch {}
          return;
        }
      }

      // Emergency — no context at all
      const fallback = await buildEmergencyFallback();
      if (fallback) {
        setOverview(fallback);
        setLastUpdated("Bez denní analýzy");
      } else if (nextOverview) {
        setOverview(nextOverview);
      }
    } catch (error: any) {
      console.error("Failed to load system overview:", error);
      // Try emergency fallback even on error
      const fallback = await buildEmergencyFallback();
      if (fallback) {
        setOverview(fallback);
        setLastUpdated("Bez denní analýzy");
      } else {
        toast.error(error?.message || "Karlův přehled se nepodařilo načíst");
      }
    } finally {
      setLoading(false);
    }
  }, [today, onTasksSynced]);

  useEffect(() => {
    void initialLoad();
  }, [initialLoad, refreshTrigger]);

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
            onClick={quickRefresh}
            disabled={refreshing || loading || forcingAnalysis}
            className="h-7 px-2 text-[0.625rem]"
          >
            {refreshing ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Obnovuji...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1 h-3 w-3" /> Obnovit
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={forceAnalysis}
            disabled={forcingAnalysis || loading || refreshing}
            className="h-7 px-2 text-[0.5625rem] text-muted-foreground"
            title="Může trvat 1-2 minuty"
          >
            {forcingAnalysis ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Analyzuji...
              </>
            ) : (
              <>
                <AlertTriangle className="mr-1 h-3 w-3" /> Vynutit analýzu
              </>
            )}
          </Button>
        </div>
      </div>

      {(loading || refreshing || forcingAnalysis) && (
        <div className="w-full mt-3 h-1 rounded-full bg-primary/10 overflow-hidden">
          <div className="h-full w-1/4 rounded-full bg-primary/60 animate-indeterminate-progress" />
        </div>
      )}

      {loading && !overview ? (
        <div className="mt-2 flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám Karlův přehled...
        </div>
      ) : overview ? (
        <div className={`mt-2 rounded-md border border-border/60 bg-background/40 p-3 ${refreshing || forcingAnalysis ? "opacity-60" : ""}`}>
          {lastUpdated && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mb-1 font-medium">⚠️ {lastUpdated}</p>
          )}
          <p className="whitespace-pre-line text-[0.6875rem] leading-5 text-foreground">{overview}</p>
        </div>
      ) : null}

      {forcingAnalysis && (
        <p className="mt-1 text-[10px] text-muted-foreground">⏱️ Kompletní analýza může trvat 1-2 minuty…</p>
      )}
    </section>
  );
};

export default DidSystemOverview;
