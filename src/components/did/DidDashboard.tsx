import { useState, useEffect, useRef } from "react";
import { Clock, AlertTriangle, Loader2, BookOpen, ListChecks, FileText, BarChart3, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import DidSystemMap from "./DidSystemMap";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { syncOverviewTasksToBoard } from "@/lib/parseOverviewTasks";
import type { DidSubMode } from "./DidSubModeSelector";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidSessionPrep from "./DidSessionPrep";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidPulseCheck from "./DidPulseCheck";
import DidColleagueView from "./DidColleagueView";
import DidKartotekaHealth from "./DidKartotekaHealth";

interface PartActivity {
  name: string;
  lastSeen: string | null;
  status: "active" | "sleeping" | "warning";
}

interface ActiveThreadSummary {
  id: string;
  partName: string;
  lastActivityAt: string;
  messageCount: number;
}

interface Props {
  onManualUpdate: () => void;
  isUpdating: boolean;
  syncProgress?: { current: number; total: number; currentName: string } | null;
  onQuickSubMode?: (subMode: DidSubMode) => void;
  onQuickThread?: (threadId: string, partName: string) => void;
  contextDocs?: string;
}

const DidDashboard = ({ onManualUpdate, isUpdating, syncProgress, onQuickSubMode, onQuickThread, contextDocs }: Props) => {
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [lastCycleTime, setLastCycleTime] = useState<string | null>(null);
  const [lastCycleStatus, setLastCycleStatus] = useState<string | null>(null);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAutoBackupRunning, setIsAutoBackupRunning] = useState(false);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [lastCycleReport, setLastCycleReport] = useState<string | null>(null);
  const [lastCardsUpdated, setLastCardsUpdated] = useState<string[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [pendingWriteCount, setPendingWriteCount] = useState(0);

  // System overview - cached between updates
  const OVERVIEW_CACHE_KEY = "karel_did_overview_cache";
  const [overviewText, setOverviewText] = useState<string>(() => {
    try {
      const cached = localStorage.getItem(OVERVIEW_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        return parsed.text || "";
      }
    } catch {}
    return "";
  });
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewLoaded, setOverviewLoaded] = useState(() => {
    try { return !!localStorage.getItem(OVERVIEW_CACHE_KEY); } catch { return false; }
  });
  const prevIsUpdatingRef = useRef(isUpdating);

  // Known DID part names to extract from overview text
  const KNOWN_PARTS = ["Arthur", "Tundrupek", "Gustík", "Raketa", "Malá", "Strážce", "Pozorovatel", "Host"];

  // Enrich parts from overview text — merge with DB-sourced parts
  useEffect(() => {
    if (!overviewText) return;
    const mentionedParts: string[] = [];
    for (const name of KNOWN_PARTS) {
      // Case-insensitive search in overview text
      if (overviewText.toLowerCase().includes(name.toLowerCase())) {
        mentionedParts.push(name);
      }
    }
    if (mentionedParts.length === 0) return;

    setParts(prev => {
      const existingNames = new Set(prev.map(p => p.name.toLowerCase()));
      const newParts: PartActivity[] = mentionedParts
        .filter(name => !existingNames.has(name.toLowerCase()))
        .map(name => ({ name, lastSeen: null, status: "sleeping" as const }));
      if (newParts.length === 0) return prev;
      return [...prev, ...newParts];
    });
  }, [overviewText]);

  useEffect(() => {
    loadDashboardData();
    loadPendingWriteCount();
  }, []);

  // Auto-load overview only if no cached version exists
  useEffect(() => {
    if (!loading && !overviewLoaded && !overviewLoading && !overviewText) {
      loadSystemOverview();
    }
  }, [loading]);

  // After manual update finishes, force-refresh dashboard + overview cache
  useEffect(() => {
    if (prevIsUpdatingRef.current && !isUpdating) {
      loadDashboardData();
      setRefreshTrigger(prev => prev + 1);
      try { localStorage.removeItem(OVERVIEW_CACHE_KEY); } catch {}
      setOverviewLoaded(false);
      setOverviewText("");
      loadSystemOverview();
    }
    prevIsUpdatingRef.current = isUpdating;
  }, [isUpdating]);

  const loadSystemOverview = async () => {
    setOverviewLoading(true);
    setOverviewText("");
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-system-overview`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );

      if (!resp.ok || !resp.body) {
        if (resp.status === 429) toast.error("Přehled systému: příliš mnoho požadavků, zkus to za chvíli.");
        else if (resp.status === 402) toast.error("Přehled systému: nedostatek kreditů.");
        else toast.error("Nepodařilo se načíst přehled systému.");
        setOverviewLoading(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              accumulated += content;
              setOverviewText(accumulated);
            }
          } catch { /* partial JSON */ }
        }
      }

      setOverviewLoaded(true);
      // Cache the overview text with the cycle timestamp
      try {
        localStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify({
          text: accumulated,
          generatedAt: new Date().toISOString(),
        }));
      } catch {}

      // Auto-sync parsed tasks to therapist task board
      try {
        const inserted = await syncOverviewTasksToBoard(accumulated);
        if (inserted > 0) {
          toast.success(`${inserted} úkolů z přehledu přidáno do seznamu`);
          setRefreshTrigger(prev => prev + 1);
        }
      } catch (e) {
        console.error("Task sync error:", e);
      }
    } catch (e) {
      console.error("System overview error:", e);
      toast.error("Chyba při načítání přehledu systému.");
    } finally {
      setOverviewLoading(false);
    }
  };

  const loadPendingWriteCount = async () => {
    const { count } = await supabase.from("did_pending_drive_writes").select("*", { count: "exact", head: true }).eq("status", "pending");
    setPendingWriteCount(count || 0);
  };

    const loadDashboardData = async () => {
    try {
      const { data: threads } = await supabase
        .from("did_threads")
        .select("id, part_name, last_activity_at, messages, sub_mode")
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false });

      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentThreads } = await supabase
        .from("did_threads")
        .select("id, part_name, last_activity_at, messages")
        .eq("sub_mode", "cast")
        .gte("last_activity_at", cutoff24h)
        .order("last_activity_at", { ascending: false });

      if (recentThreads) {
        setActiveThreads(recentThreads.map(t => ({
          id: t.id,
          partName: t.part_name,
          lastActivityAt: t.last_activity_at,
          messageCount: Array.isArray(t.messages) ? t.messages.length : 0,
        })));
      }

      if (threads) {
        const partMap = new Map<string, string>();
        for (const t of threads) {
          if (!partMap.has(t.part_name)) partMap.set(t.part_name, t.last_activity_at);
        }
        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        const oneDay = 24 * 60 * 60 * 1000;
        const partList: PartActivity[] = Array.from(partMap.entries()).map(([name, lastSeen]) => {
          const diff = now - new Date(lastSeen).getTime();
          let status: PartActivity["status"] = "sleeping";
          if (diff < oneDay) status = "active";
          else if (diff > sevenDays) status = "warning";
          return { name, lastSeen, status };
        });
        setParts(partList);
      }

      const { data: cycles } = await supabase
        .from("did_update_cycles")
        .select("created_at, started_at, completed_at, status, report_summary, cards_updated")
        .order("created_at", { ascending: false })
        .limit(1);

      if (cycles && cycles.length > 0) {
        const latestCycle = cycles[0];
        const cycleTs = latestCycle.completed_at || latestCycle.started_at || latestCycle.created_at;
        setLastCycleTime(cycleTs);
        setLastCycleStatus(latestCycle.status || null);
        setLastCycleReport(latestCycle.report_summary || null);
        const cards = latestCycle.cards_updated;
        if (Array.isArray(cards)) {
          setLastCardsUpdated(cards.map((c: any) => typeof c === "string" ? c : c?.name || ""));
        }
      } else if (threads && threads.length > 0) {
        // Fallback: use latest thread activity as proxy for last update
        setLastCycleTime(threads[0].last_activity_at);
        setLastCycleStatus(null);
      }

      const { data: dailyCycles } = await supabase
        .from("did_update_cycles")
        .select("completed_at")
        .eq("status", "completed")
        .eq("cycle_type", "daily")
        .order("completed_at", { ascending: false })
        .limit(1);

      const lastDaily = dailyCycles?.[0]?.completed_at || null;
      setLastBackupTime(lastDaily);

      // Auto-backup removed: daily cycle runs only via pg_cron or manual "Aktualizovat kartotéku" button
    } finally {
      setLoading(false);
    }
  };

  const formatTimeAgo = (isoStr: string | null) => {
    if (!isoStr) return "nikdy";
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "právě teď";
    if (mins < 60) return `před ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `před ${hours} h`;
    const days = Math.floor(hours / 24);
    return `před ${days} dny`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <p className="text-[10px] sm:text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Poslední aktualizace kartoteka_DID: {lastCycleTime ? new Date(lastCycleTime).toLocaleString("cs-CZ", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "zatím neproběhla"}
            {lastCycleStatus === "running" ? " (probíhá)" : lastCycleStatus === "failed" ? " (selhalo)" : ""}
          </p>
          <DidSessionPrep />
        </div>
        {lastCardsUpdated.length > 0 && (
          <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5">
            Naposledy aktualizováno: {lastCardsUpdated.slice(0, 5).join(", ")}{lastCardsUpdated.length > 5 ? ` (+${lastCardsUpdated.length - 5})` : ""}
          </p>
        )}
        {lastCycleReport && (
          <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 line-clamp-2">
            📋 {lastCycleReport.slice(0, 150)}{lastCycleReport.length > 150 ? "…" : ""}
          </p>
        )}
        {isAutoBackupRunning && (
          <p className="text-[10px] sm:text-xs text-primary flex items-center gap-1 mt-0.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            Probíhá automatická záloha...
          </p>
        )}
      </div>

      {/* Streaming system overview */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5 text-primary" />
            Karlův přehled
          </h4>
          {overviewLoaded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setOverviewLoaded(false); setOverviewText(""); try { localStorage.removeItem(OVERVIEW_CACHE_KEY); } catch {} loadSystemOverview(); }}
              className="h-6 text-[10px] px-2"
            >
              Obnovit
            </Button>
          )}
        </div>
        {overviewLoading && !overviewText && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Karel analyzuje systém a připravuje přehled...
          </div>
        )}
        {overviewText && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] sm:text-xs leading-relaxed">
            <ReactMarkdown
              components={{
                h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1.5 first:mt-0">{children}</h2>,
                h3: ({ children }) => <h3 className="text-xs font-medium text-foreground mt-2 mb-1">{children}</h3>,
                p: ({ children }) => <p className="text-muted-foreground mb-2 leading-relaxed">{children}</p>,
                a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{children}</a>,
                strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
              }}
            >
              {overviewText}
            </ReactMarkdown>
            {overviewLoading && <Loader2 className="w-3 h-3 animate-spin text-primary inline-block ml-1" />}
          </div>
        )}
      </div>

      {/* Therapist Tasks */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <ListChecks className="w-3.5 h-3.5 text-primary" />
            Úkoly pro terapeutky
          </h4>
          {pendingWriteCount > 0 && (
            <Badge variant="secondary" className="text-[8px] h-4 px-1.5 flex items-center gap-1">
              <Upload className="w-2.5 h-2.5" />
              {pendingWriteCount} čeká na Drive
            </Badge>
          )}
        </div>
        <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
      </div>

      {/* Agreements Panel */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
        <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger(prev => prev + 1)} />
      </div>

      {/* Monthly Panel */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
        <DidMonthlyPanel refreshTrigger={refreshTrigger} />
      </div>

      {/* Pulse Check */}
      <div className="mb-4">
        <DidPulseCheck refreshTrigger={refreshTrigger} />
      </div>

      {/* Colleague View */}
      <div className="mb-4">
        <DidColleagueView refreshTrigger={refreshTrigger} />
      </div>

      {/* Kartotéka Health Check */}
      <div className="mb-4">
        <DidKartotekaHealth refreshTrigger={refreshTrigger} />
      </div>

      {/* System Map */}
      <DidSystemMap
        parts={parts}
        activeThreads={activeThreads}
        onQuickThread={onQuickThread}
        onDeletePart={async (partName) => {
          // Delete all threads for this part from the database
          const { error } = await supabase
            .from("did_threads")
            .delete()
            .eq("part_name", partName)
            .eq("sub_mode", "cast");
          if (error) {
            toast.error(`Nepodařilo se smazat vlákna pro ${partName}`);
          } else {
            toast.success(`Vlákna pro „${partName}" smazána z mapy`);
            setParts(prev => prev.filter(p => p.name !== partName));
            setActiveThreads(prev => prev.filter(t => t.partName !== partName));
          }
        }}
      />

      {/* Warnings */}
      {parts.filter(p => p.status === "warning").length > 0 && (
        <div className="mt-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 mb-1">
            <AlertTriangle className="w-4 h-4" />
            Upozornění na neaktivní části
          </div>
          <p className="text-xs text-muted-foreground">
            {parts.filter(p => p.status === "warning").map(p => p.name).join(", ")} – neaktivní více než 7 dní. Zvažte oslovení.
          </p>
        </div>
      )}
    </div>
  );
};

export default DidDashboard;
