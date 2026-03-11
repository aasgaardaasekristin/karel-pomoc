import { useState, useEffect, useMemo } from "react";
import { Clock, AlertTriangle, Loader2, MessageCircle, Zap, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import DidSystemMap from "./DidSystemMap";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import type { DidSubMode } from "./DidSubModeSelector";

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
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAutoBackupRunning, setIsAutoBackupRunning] = useState(false);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [lastCycleReport, setLastCycleReport] = useState<string | null>(null);
  const [lastCardsUpdated, setLastCardsUpdated] = useState<string[]>([]);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Get all unique part names from threads
      const { data: threads } = await supabase
        .from("did_threads")
        .select("id, part_name, last_activity_at, messages, sub_mode")
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false });

      // Show unprocessed threads (not 24h limit) — visible until Karel processes them
      const { data: recentThreads } = await supabase
        .from("did_threads")
        .select("id, part_name, last_activity_at, messages")
        .eq("sub_mode", "cast")
        .eq("is_processed", false)
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
          if (!partMap.has(t.part_name)) {
            partMap.set(t.part_name, t.last_activity_at);
          }
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

      // Get last update cycle (any type)
      const { data: cycles } = await supabase
        .from("did_update_cycles")
        .select("completed_at, report_summary, cards_updated")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1);

      if (cycles && cycles.length > 0) {
        setLastCycleTime(cycles[0].completed_at);
        setLastCycleReport(cycles[0].report_summary || null);
        const cards = cycles[0].cards_updated;
        if (Array.isArray(cards)) {
          setLastCardsUpdated(cards.map((c: any) => typeof c === "string" ? c : c?.name || ""));
        }
      }

      // Check last daily cycle for auto-backup
      const { data: dailyCycles } = await supabase
        .from("did_update_cycles")
        .select("completed_at")
        .eq("status", "completed")
        .eq("cycle_type", "daily")
        .order("completed_at", { ascending: false })
        .limit(1);

      const lastDaily = dailyCycles?.[0]?.completed_at || null;
      setLastBackupTime(lastDaily);

      // Auto-backup if last daily cycle was more than 24h ago
      const twentyFourHours = 24 * 60 * 60 * 1000;
      const needsBackup = !lastDaily || (Date.now() - new Date(lastDaily).getTime() > twentyFourHours);
      
      if (needsBackup) {
        setIsAutoBackupRunning(true);
        toast.info("Automatická záloha kartotéky se spouští...");
        try {
          const headers = await getAuthHeaders();
          const backupResponse = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`,
            { method: "POST", headers, body: JSON.stringify({}) }
          );
          if (backupResponse.ok) {
            toast.success("Automatická záloha kartotéky dokončena");
            setLastBackupTime(new Date().toISOString());
          }
        } catch (e) {
          console.warn("Auto-backup failed:", e);
        } finally {
          setIsAutoBackupRunning(false);
        }
      }
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

  // Extract key insights from preloaded 00_CENTRUM docs
  const contextSummary = useMemo(() => {
    if (!contextDocs) return null;
    const sections: { title: string; content: string }[] = [];

    // Extract dashboard section
    const dashboardMatch = contextDocs.match(/\[Kartoteka_DID\/00_CENTRUM: 00_Aktualni_Dashboard\]\n([\s\S]*?)(?=\[Kartoteka_DID|$)/);
    if (dashboardMatch) {
      const text = dashboardMatch[1].trim().slice(0, 600);
      if (text && !text.startsWith("[Dokument")) {
        sections.push({ title: "Aktuální dashboard", content: text });
      }
    }

    // Extract therapeutic plan
    const planMatch = contextDocs.match(/\[Kartoteka_DID\/00_CENTRUM: 05_Terapeuticky_Plan_Aktualni\]\n([\s\S]*?)(?=\[Kartoteka_DID|$)/);
    if (planMatch) {
      const text = planMatch[1].trim().slice(0, 400);
      if (text && !text.startsWith("[Dokument")) {
        sections.push({ title: "Terapeutický plán", content: text });
      }
    }

    // Extract relationship map highlights
    const mapMatch = contextDocs.match(/\[Kartoteka_DID\/00_CENTRUM: Mapa_Vztahu_a_Vazeb\]\n([\s\S]*?)(?=\[Kartoteka_DID|$)/);
    if (mapMatch) {
      const text = mapMatch[1].trim().slice(0, 300);
      if (text && !text.startsWith("[Dokument")) {
        sections.push({ title: "Mapa vztahů", content: text });
      }
    }

    return sections.length > 0 ? sections : null;
  }, [contextDocs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4">
      {/* Header with last update indicator */}
      <div className="mb-4">
        <h3 className="text-sm font-medium text-foreground">Přehled systému</h3>
        <p className="text-[10px] sm:text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
          <Clock className="w-3 h-3" />
          Poslední aktualizace kartotéky: {formatTimeAgo(lastCycleTime)}
        </p>
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

      {/* Context summary from 00_CENTRUM */}
      {contextSummary && (
        <div className="mb-4 space-y-2">
          {contextSummary.map((section, idx) => (
            <details key={idx} className="rounded-lg border border-border bg-card/50 overflow-hidden">
              <summary className="flex items-center gap-2 text-xs font-medium text-foreground px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors">
                <Info className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                {section.title}
              </summary>
              <div className="px-3 pb-2 text-[11px] text-muted-foreground whitespace-pre-line leading-relaxed">
                {section.content}
              </div>
            </details>
          ))}
        </div>
      )}

      {/* Quick Entry — unprocessed threads (visible until Karel processes them) */}
      {activeThreads.length > 0 && onQuickThread && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Navázat na rozhovor
          </h4>
          <div className="flex flex-wrap gap-2">
            {activeThreads.map(t => (
              <Button
                key={t.id}
                variant="outline"
                size="sm"
                onClick={() => onQuickThread(t.id, t.partName)}
                className="h-9 text-xs gap-1.5 border-primary/30 hover:border-primary"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                {t.partName}
                <span className="text-muted-foreground">({formatTimeAgo(t.lastActivityAt)})</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* System Map (clickable squares + chronology) */}
      <DidSystemMap parts={parts} activeThreads={activeThreads} onQuickThread={onQuickThread} />

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
