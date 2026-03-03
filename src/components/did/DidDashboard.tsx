import { useState, useEffect } from "react";
import { Clock, AlertTriangle, CheckCircle, Moon, RefreshCw, Loader2, MessageCircle, Zap, FileText } from "lucide-react";
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
  onQuickSubMode?: (subMode: DidSubMode) => void;
  onQuickThread?: (threadId: string, partName: string) => void;
}

const DidDashboard = ({ onManualUpdate, isUpdating, onQuickSubMode, onQuickThread }: Props) => {
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [lastCycleTime, setLastCycleTime] = useState<string | null>(null);
  const [lastBackupTime, setLastBackupTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAutoBackupRunning, setIsAutoBackupRunning] = useState(false);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [isReformatting, setIsReformatting] = useState(false);
  const [reformatProgress, setReformatProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Get all unique part names from threads
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: threads } = await supabase
        .from("did_threads")
        .select("id, part_name, last_activity_at, messages, sub_mode")
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false });

      // Extract active threads (last 24h) for system map click-to-resume
      // Include ALL recent threads regardless of is_processed status
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

      // Get last update cycle
      const { data: cycles } = await supabase
        .from("did_update_cycles")
        .select("completed_at")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1);

      if (cycles && cycles.length > 0) {
        setLastCycleTime(cycles[0].completed_at);
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

  const statusIcon = (status: PartActivity["status"]) => {
    switch (status) {
      case "active": return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "sleeping": return <Moon className="w-4 h-4 text-muted-foreground" />;
      case "warning": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    }
  };

  const statusLabel = (status: PartActivity["status"]) => {
    switch (status) {
      case "active": return "aktivní";
      case "sleeping": return "spí";
      case "warning": return "⚠️ neaktivní 7+ dní";
    }
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
      {/* Header with last update indicator */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Přehled systému</h3>
          <p className="text-[10px] sm:text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3" />
            Poslední aktualizace kartotéky: {formatTimeAgo(lastCycleTime)}
          </p>
          {isAutoBackupRunning && (
            <p className="text-[10px] sm:text-xs text-primary flex items-center gap-1 mt-0.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Probíhá automatická záloha...
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onManualUpdate}
          disabled={isUpdating}
          className="h-8 text-xs gap-1.5"
        >
          {isUpdating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">Aktualizovat kartoteka_DID ihned</span>
          <span className="sm:hidden">Aktual. kartotéku</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            setIsReformatting(true);
            setReformatProgress(null);
            toast.info("Načítám seznam karet...");
            try {
              const headers = await getAuthHeaders();
              // Step 1: Get list of entries + classify txt
              const listRes = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
                { method: "POST", headers, body: JSON.stringify({ mode: "list" }) }
              );
              const listData = await listRes.json();
              if (!listRes.ok) throw new Error(listData.error);

              const entries = listData.entries || [];
              const txtContentByPart = listData.txtContentByPart || {};
              const total = entries.length;
              let reformatted = 0, notFound = 0, errors = 0;

              toast.info(`Přeformátování ${total} karet zahájeno...`);

              // Step 2: Process each card one by one
              for (let i = 0; i < total; i++) {
                const entry = entries[i];
                setReformatProgress({ current: i + 1, total, currentName: entry.name });
                try {
                  const res = await fetch(
                    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
                    { method: "POST", headers, body: JSON.stringify({ mode: "process_one", index: i, txtContentForPart: txtContentByPart[entry.name] || "" }) }
                  );
                  const data = await res.json();
                  if (data.result === "reformatted") reformatted++;
                  else if (data.result === "not_found") notFound++;
                  else errors++;
                } catch (e) {
                  console.error(`Card ${entry.name} failed:`, e);
                  errors++;
                }
              }

              // Step 3: Cleanup txt files
              if ((listData.txtFiles || []).length > 0) {
                try {
                  await fetch(
                    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
                    { method: "POST", headers, body: JSON.stringify({ mode: "cleanup_txt" }) }
                  );
                } catch {}
              }

              toast.success(`Hotovo! Přeformátováno: ${reformatted}/${total}, nenalezeno: ${notFound}, chyby: ${errors}`);
            } catch (e) {
              toast.error("Přeformátování selhalo");
              console.error(e);
            } finally {
              setIsReformatting(false);
              setReformatProgress(null);
            }
          }}
          disabled={isReformatting}
          className="h-8 text-xs gap-1.5"
        >
          {isReformatting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FileText className="w-3.5 h-3.5" />
          )}
          {reformatProgress ? (
            <span>{reformatProgress.current}/{reformatProgress.total} {reformatProgress.currentName}</span>
          ) : (
            <>
              <span className="hidden sm:inline">Přeformátovat karty A–M</span>
              <span className="sm:hidden">Přeformátovat</span>
            </>
          )}
        </Button>
      </div>

      {/* Parts overview */}
      {/* Quick Entry — active threads from last 24h */}
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

      {/* Interactive System Map */}
      <DidSystemMap parts={parts} activeThreads={activeThreads} onQuickThread={onQuickThread} />

      {parts.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {parts.map((part) => (
            <div
              key={part.name}
              className={`rounded-lg border p-3 ${
                part.status === "warning"
                  ? "border-yellow-500/50 bg-yellow-500/5"
                  : part.status === "active"
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-border bg-card/50"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {statusIcon(part.status)}
                <span className="text-sm font-medium text-foreground truncate">{part.name}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {statusLabel(part.status)} • {formatTimeAgo(part.lastSeen)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-4 text-xs text-muted-foreground text-center">
          Zatím žádné záznamy o částech. Data se naplní po prvních rozhovorech.
        </div>
      )}

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

      {/* Pattern detection is now automated in daily/weekly cycles */}
    </div>
  );
};

export default DidDashboard;
