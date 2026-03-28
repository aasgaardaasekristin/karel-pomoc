import { useState, useEffect } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, ClipboardList, Trash2, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import ThemeEditorDialog from "@/components/ThemeEditorDialog";
import DidKartotekaHealth from "./DidKartotekaHealth";
import DidRegistryOverview from "./DidRegistryOverview";
import DidCardCleanup from "./DidCardCleanup";
import DidReportDiagnostics from "./DidReportDiagnostics";
import DidKartotekaTab from "./DidKartotekaTab";
import DidPlanTab from "./DidPlanTab";

interface Props {
  onBootstrap: () => void;
  isBootstrapping: boolean;
  onHealthAudit: () => void;
  isAuditing: boolean;
  onReformat?: () => void;
  isReformatting?: boolean;
  onManualUpdate?: () => void;
  isUpdating?: boolean;
  onCentrumSync?: () => void;
  isCentrumSyncing?: boolean;
  onCleanupTasks?: () => void;
  isCleaningTasks?: boolean;
  onRefreshMemory?: () => void;
  isRefreshingMemory?: boolean;
  refreshTrigger?: number;
  onSelectPart?: (partName: string) => void;
}

interface CycleStatus {
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSummary: string | null;
}

interface ProcessingStats {
  unprocessedThreads: number;
}

function useProcessingStatus(refreshTrigger: number) {
  const [cycleStatus, setCycleStatus] = useState<CycleStatus>({ lastRunAt: null, lastStatus: null, lastSummary: null });
  const [stats, setStats] = useState<ProcessingStats>({ unprocessedThreads: 0 });

  useEffect(() => {
    async function load() {
      const [cycleRes, threadsRes] = await Promise.all([
        supabase
          .from("did_update_cycles")
          .select("completed_at, status, report_summary")
          .order("started_at", { ascending: false })
          .limit(1),
        supabase
          .from("did_threads")
          .select("id", { count: "exact", head: true })
          .eq("sub_mode", "cast")
          .eq("is_processed", false),
      ]);

      if (cycleRes.data?.[0]) {
        const c = cycleRes.data[0];
        setCycleStatus({
          lastRunAt: c.completed_at || null,
          lastStatus: c.status,
          lastSummary: c.report_summary || null,
        });
      }

      setStats({ unprocessedThreads: threadsRes.count ?? 0 });
    }

    load();
  }, [refreshTrigger]);

  return { cycleStatus, stats };
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "nikdy";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "právě teď";
  if (mins < 60) return `před ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `před ${hours}h`;
  const days = Math.floor(hours / 24);
  return `před ${days}d`;
}

const DidSprava = ({
  onBootstrap,
  isBootstrapping,
  onHealthAudit,
  isAuditing,
  onReformat,
  isReformatting,
  onManualUpdate,
  isUpdating,
  onCentrumSync,
  isCentrumSyncing,
  onCleanupTasks,
  isCleaningTasks,
  onRefreshMemory,
  isRefreshingMemory,
  refreshTrigger = 0,
  onSelectPart,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"tools" | "theme" | "health" | "registry" | "reports" | "cleanup" | "kartoteka" | "plan">("tools");
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const { cycleStatus, stats } = useProcessingStatus(refreshTrigger);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] gap-1.5 relative">
          <Settings className="w-3 h-3" />
          Správa
          {stats.unprocessedThreads > 0 && (
            <Badge className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[9px] bg-destructive text-destructive-foreground">
              {stats.unprocessedThreads}
            </Badge>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" />
            Správa DID režimu
          </DialogTitle>
          <DialogDescription className="text-xs">Nástroje a osobní nastavení vzhledu pro každou personu zvlášť.</DialogDescription>
        </DialogHeader>

        {/* Status bar */}
        <StatusBar cycleStatus={cycleStatus} unprocessedThreads={stats.unprocessedThreads} />

        <div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-muted flex-wrap">
         {([
            { key: "tools" as const, label: "🛠 Nástroje" },
            { key: "kartoteka" as const, label: "📋 Kartotéka" },
            { key: "health" as const, label: "❤️ Zdraví" },
            { key: "registry" as const, label: "📋 Registr" },
            { key: "reports" as const, label: "📧 Reporty" },
            { key: "cleanup" as const, label: "🧹 Cleanup" },
            { key: "theme" as const, label: "🎨 Vzhled" },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === tab.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "tools" && (
          <div className="space-y-2">
            {onRefreshMemory && (
              <ToolButton
                icon={<Brain className={`w-4 h-4 text-violet-600 ${isRefreshingMemory ? "animate-pulse" : ""}`} />}
                title="Osvěž paměť"
                desc="Vynutit novou situační cache z Drive, DB a analýzy"
                loading={isRefreshingMemory}
                onClick={() => { onRefreshMemory(); setOpen(false); }}
              />
            )}

            {onManualUpdate && (
              <ToolButton
                icon={<RefreshCw className={`w-4 h-4 text-primary ${isUpdating ? "animate-spin" : ""}`} />}
                title="Aktualizovat kartotéku"
                desc="Synchronizace dat z rozhovorů do karet na Drive"
                loading={isUpdating}
                onClick={() => { onManualUpdate(); setOpen(false); }}
                badge={stats.unprocessedThreads > 0 ? `${stats.unprocessedThreads} vláken` : undefined}
              />
            )}

            {onCentrumSync && (
              <ToolButton
                icon={<ClipboardList className={`w-4 h-4 text-emerald-600 ${isCentrumSyncing ? "animate-pulse" : ""}`} />}
                title="Aktualizovat Centrum"
                desc="Dashboard + operativní plán + CENTRUM dokumenty"
                loading={isCentrumSyncing}
                onClick={() => { onCentrumSync(); setOpen(false); }}
              />
            )}

            {onCleanupTasks && (
              <ToolButton
                icon={<Trash2 className={`w-4 h-4 text-amber-600 ${isCleaningTasks ? "animate-pulse" : ""}`} />}
                title="Vyčistit úkoly"
                desc="Archivovat not_started úkoly starší 7 dní"
                loading={isCleaningTasks}
                onClick={() => { onCleanupTasks(); setOpen(false); }}
              />
            )}

            <ToolButton
              icon={<HeartPulse className={`w-4 h-4 text-primary ${isAuditing ? "animate-pulse" : ""}`} />}
              title="Audit zdraví kartotéky"
              desc="Kontrola integrity a úplnosti karet"
              loading={isAuditing}
              onClick={() => { onHealthAudit(); setOpen(false); }}
            />

            {onReformat && (
              <ToolButton
                icon={<RefreshCw className={`w-4 h-4 text-primary ${isReformatting ? "animate-spin" : ""}`} />}
                title="Přeformátovat karty"
                desc="Sjednocení formátu všech karet"
                loading={isReformatting}
                onClick={() => { onReformat(); setOpen(false); }}
              />
            )}

            <ToolButton
              icon={<Database className={`w-4 h-4 text-primary ${isBootstrapping ? "animate-pulse" : ""}`} />}
              title="Bootstrap DID paměti"
              desc="Jednorázové nasátí všech karet z Drive do registru"
              loading={isBootstrapping}
              onClick={() => { onBootstrap(); setOpen(false); }}
            />
          </div>
        )}

        {activeTab === "health" && (
          <div className="space-y-2">
            <DidKartotekaHealth refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "registry" && (
          <div className="space-y-2">
            <DidRegistryOverview
              refreshTrigger={refreshTrigger}
              onSelectPart={onSelectPart}
            />
          </div>
        )}

        {activeTab === "reports" && (
          <div className="space-y-2">
            <DidReportDiagnostics refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "cleanup" && (
          <div className="space-y-2">
            <DidCardCleanup />
          </div>
        )}

        {activeTab === "kartoteka" && (
          <div className="space-y-2">
            <DidKartotekaTab />
          </div>
        )}

        {activeTab === "theme" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <p className="text-xs text-muted-foreground">Nastavení vzhledu bylo přesunuto do vlastního dialogu.</p>
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => { setOpen(false); setThemeDialogOpen(true); }}>
              🎨 Otevřít nastavení vzhledu
            </Button>
          </div>
        )}
        <ThemeEditorDialog open={themeDialogOpen} onOpenChange={setThemeDialogOpen} />
      </DialogContent>
    </Dialog>
  );
};

/* ── Status bar showing last run info ── */
function StatusBar({ cycleStatus, unprocessedThreads }: { cycleStatus: CycleStatus; unprocessedThreads: number }) {
  const statusColor = cycleStatus.lastStatus === "completed"
    ? "text-emerald-600"
    : cycleStatus.lastStatus === "failed"
      ? "text-destructive"
      : "text-muted-foreground";

  const statusLabel = cycleStatus.lastStatus === "completed"
    ? "✅ Úspěch"
    : cycleStatus.lastStatus === "failed"
      ? "❌ Chyba"
      : cycleStatus.lastStatus === "running"
        ? "⏳ Běží"
        : "—";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-md bg-muted/50 text-[0.625rem] text-muted-foreground mb-2">
      <span>
        Poslední cyklus: <strong className="text-foreground">{formatRelativeTime(cycleStatus.lastRunAt)}</strong>
      </span>
      <span>
        Status: <strong className={statusColor}>{statusLabel}</strong>
      </span>
      <span>
        Nezpracovaná vlákna: <strong className={unprocessedThreads > 0 ? "text-amber-600" : "text-foreground"}>{unprocessedThreads}</strong>
      </span>
    </div>
  );
}

/* ── Tool button ── */
function ToolButton({ icon, title, desc, loading, onClick, badge }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  loading?: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`w-full flex flex-col gap-0 p-3 rounded-lg border transition-colors text-left ${
        loading
          ? "border-primary/30 bg-primary/5 cursor-wait"
          : "border-border hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3 w-full">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-foreground">{title}</p>
            {badge && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                {badge}
              </Badge>
            )}
          </div>
          <p className="text-[0.625rem] text-muted-foreground">
            {loading ? "Probíhá..." : desc}
          </p>
        </div>
        {loading && <Loader2 className="w-3 h-3 animate-spin ml-auto shrink-0" />}
      </div>
      {loading && (
        <div className="w-full mt-2 h-1 rounded-full bg-primary/10 overflow-hidden">
          <div className="h-full w-1/4 rounded-full bg-primary/60 animate-indeterminate-progress" />
        </div>
      )}
    </button>
  );
}

export default DidSprava;
