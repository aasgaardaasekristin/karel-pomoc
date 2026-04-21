import { useState, useEffect, useCallback } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, ClipboardList, Trash2, Brain, AlertTriangle, Play, Square, Activity } from "lucide-react";
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
// Slice 3A (2026-04-21): „Krize" tab odstraněn — single crisis detail owner =
// CrisisDetailWorkspace přes useCrisisDetail(). DidCrisisPanel se otevírá
// už jen z CrisisAlert / KarelCrisisDeficits / CommandCrisisCard.
import DidMemoryTab from "./DidMemoryTab";
import DidTrendsTab from "./DidTrendsTab";
import DidTherapistNotes from "./DidTherapistNotes";
import DidGoalsTab from "./DidGoalsTab";
import DidSafetyAlerts from "./DidSafetyAlerts";
import WriteQueueInbox from "./WriteQueueInbox";
import SessionPacketPanel from "./SessionPacketPanel";
import HandoffPanel from "./HandoffPanel";
import RecoveryPanel from "./RecoveryPanel";
import DidLiveSessionPanel from "./DidLiveSessionPanel";
import PendingQuestionsPanel from "./PendingQuestionsPanel";
import DidWorkingMemoryPanel from "./DidWorkingMemoryPanel";
import HourglassInspectPanel from "./HourglassInspectPanel";
import { useOperationalInboxCounts } from "@/hooks/useOperationalInboxCounts";

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

interface RunningCycle {
  id: string;
  started_at: string;
  status: string;
  phase: string | null;
  phase_detail: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  heartbeatAgeSec: number | null;
  stuck: boolean;
}

interface CycleHealth {
  lastCompleted: { id: string; completed_at: string | null; status: string; phase: string | null; last_error: string | null; report_summary: string | null } | null;
  running: RunningCycle | null;
  loading: boolean;
}

function useCycleHealth(refreshTrigger: number): { health: CycleHealth; reload: () => void } {
  const [health, setHealth] = useState<CycleHealth>({ lastCompleted: null, running: null, loading: true });

  const reload = useCallback(async () => {
    setHealth(h => ({ ...h, loading: true }));
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-daily-cycle", { body: { action: "status" } });
      if (error) throw error;
      setHealth({
        lastCompleted: data?.lastCompleted ?? null,
        running: data?.running ?? null,
        loading: false,
      });
    } catch (e) {
      console.warn("[DidSprava] status fetch failed", e);
      setHealth({ lastCompleted: null, running: null, loading: false });
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload, refreshTrigger]);

  return { health, reload };
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

function formatHeartbeatAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
  const [activeTab, setActiveTab] = useState<"tools" | "theme" | "health" | "registry" | "reports" | "cleanup" | "kartoteka" | "plan" | "memory" | "notes" | "trends" | "goals" | "safety" | "writes" | "packet" | "handoff" | "recovery" | "live" | "questions" | "wm">("tools");
  const opsSnapshot = useOperationalInboxCounts(refreshTrigger);
  const [livePlan, setLivePlan] = useState<{ id: string; partName: string; therapistName: string; contextBrief: string } | null>(null);
  const [livePlans, setLivePlans] = useState<Array<{ id: string; selected_part: string; session_lead: string; therapist?: string | null; plan_markdown: string; status: string; plan_date: string }>>([]);
  const [livePlansLoading, setLivePlansLoading] = useState(false);
  const [newAlertCount, setNewAlertCount] = useState(0);
  // Slice 3A: hasCrisis state odstraněn (Krize tab je pryč).
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const { cycleStatus, stats } = useProcessingStatus(refreshTrigger);
  const { health, reload: reloadHealth } = useCycleHealth(refreshTrigger);
  const [isTriggeringFullCycle, setIsTriggeringFullCycle] = useState(false);
  const [isResettingStuck, setIsResettingStuck] = useState(false);

  const triggerFullCycle = useCallback(async () => {
    setIsTriggeringFullCycle(true);
    toast.info("Spouštím plný denní cyklus (manual)…");
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-daily-cycle", {
        body: { source: "manual" },
      });
      if (error) throw error;
      if (data?.reason === "already_running") {
        toast.warning(`Cyklus už běží: ${data.cycleId?.slice(0, 8) ?? "?"}`);
      } else if (data?.status === "skipped") {
        toast.info(`Přeskočeno: ${data.reason}`);
      } else {
        toast.success("Plný cyklus spuštěn — sleduj StatusBar (heartbeat se obnovuje co ~45s).");
      }
    } catch (e: any) {
      toast.error(`Chyba spuštění: ${e?.message ?? String(e)}`);
    } finally {
      setIsTriggeringFullCycle(false);
      reloadHealth();
    }
  }, [reloadHealth]);

  const resetStuckRun = useCallback(async () => {
    if (!health.running) return;
    setIsResettingStuck(true);
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-daily-cycle", {
        body: { action: "force_fail", cycleId: health.running.id, reason: "admin_ui_reset" },
      });
      if (error) throw error;
      toast.success(`Označeno jako failed: ${data?.failedCount ?? 0} běh(ů)`);
    } catch (e: any) {
      toast.error(`Reset selhal: ${e?.message ?? String(e)}`);
    } finally {
      setIsResettingStuck(false);
      reloadHealth();
    }
  }, [health.running, reloadHealth]);

  useEffect(() => {
    // Slice 3A: hasCrisis flag se už nepoužívá pro „Krize" tab (odstraněn).
    // Necháváme jen safety_alerts polling pro badge na „Bezpečnost" tabu.
    const loadAlertCount = async () => {
      const { count } = await (supabase as any).from("safety_alerts").select("id", { count: "exact", head: true }).eq("status", "new");
      setNewAlertCount(count || 0);
    };
    loadAlertCount();
    const interval = setInterval(loadAlertCount, 30000);
    return () => clearInterval(interval);
  }, [refreshTrigger]);

  // ── Crisis Workspace Precision Routing Pass (2026-04-21) ──
  // Deep-link: jiná část aplikace (např. CrisisDetailWorkspace) může do
  // sessionStorage uložit klíč `karel_sprava_open_tab` s názvem tabu
  // (např. "questions"). Tento effect ho přečte, otevře dialog Správa
  // a přepne na požadovaný tab. Klíč po použití mažeme.
  useEffect(() => {
    try {
      const requested = sessionStorage.getItem("karel_sprava_open_tab");
      if (!requested) return;
      sessionStorage.removeItem("karel_sprava_open_tab");
      // Whitelist: jen taby, které tento komponent zná.
      const allowed = ["safety","questions","writes","packet","handoff","recovery","live","tools","plan","kartoteka","memory","notes","trends","goals","health","registry","reports","cleanup","wm","theme"] as const;
      if ((allowed as readonly string[]).includes(requested)) {
        setActiveTab(requested as typeof activeTab);
        setOpen(true);
      }
    } catch { /* ignore */ }
  }, []);

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

        {/* Truthful run health bar */}
        <CycleHealthBar
          health={health}
          unprocessedThreads={stats.unprocessedThreads}
          onReload={reloadHealth}
          onTriggerFullCycle={triggerFullCycle}
          onResetStuck={resetStuckRun}
          isTriggering={isTriggeringFullCycle}
          isResetting={isResettingStuck}
        />

        <div className="flex gap-1 mb-3 p-1 rounded-lg bg-muted flex-wrap">
         {([
            { key: "safety" as const, label: newAlertCount > 0 ? `Bezpečnost (${newAlertCount})` : "Bezpečnost" },
             { key: "questions" as const, label: opsSnapshot.pendingQuestions > 0 ? `❓ Otázky (${opsSnapshot.pendingQuestions})` : "❓ Otázky" },
             { key: "writes" as const, label: "📝 Zápisy" },
             { key: "packet" as const, label: "📦 Packet" },
             { key: "handoff" as const, label: "🔄 Předávka" },
              { key: "recovery" as const, label: "💓 Recovery" },
              { key: "live" as const, label: "⚡ Live" },
            { key: "tools" as const, label: "Nástroje" },
            // Slice 3A (2026-04-21): „Krize" tab odstraněn — viz CrisisDetailWorkspace.
            { key: "plan" as const, label: "Plán" },
            { key: "kartoteka" as const, label: "Kartotéka" },
            { key: "memory" as const, label: "Paměť" },
            { key: "notes" as const, label: "Poznámky" },
            { key: "trends" as const, label: "Trendy" },
            { key: "goals" as const, label: "Cíle" },
            { key: "health" as const, label: "Zdraví" },
            { key: "registry" as const, label: "Registr" },
            { key: "reports" as const, label: "Reporty" },
            { key: "cleanup" as const, label: "Cleanup" },
            { key: "wm" as const, label: "🧠 WM" },
            { key: "theme" as const, label: "Vzhled" },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-2 py-1 text-[10px] whitespace-nowrap rounded-md transition-colors ${activeTab === tab.key ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "questions" && (
          <div className="space-y-2">
            <PendingQuestionsPanel refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "writes" && (
          <div className="space-y-2">
            <WriteQueueInbox refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "packet" && (
          <div className="space-y-2">
            <SessionPacketPanel refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "handoff" && (
          <div className="space-y-2">
            <HandoffPanel refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "recovery" && (
          <div className="space-y-2">
            <RecoveryPanel refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "live" && (
          <div className="space-y-3">
            {livePlan ? (
              <div className="min-h-[400px]">
                <DidLiveSessionPanel
                  partName={livePlan.partName}
                  therapistName={livePlan.therapistName}
                  contextBrief={livePlan.contextBrief}
                  onEnd={() => {
                    setLivePlan(null);
                    toast.success("Sezení ukončeno a uloženo.");
                  }}
                  onBack={() => setLivePlan(null)}
                />
              </div>
            ) : (
              <LivePlanPicker
                plans={livePlans}
                loading={livePlansLoading}
                onLoad={() => {
                  setLivePlansLoading(true);
                  supabase
                    .from("did_daily_session_plans")
                    .select("id, selected_part, session_lead, therapist, plan_markdown, status, plan_date")
                    .in("status", ["generated", "in_progress"])
                    .order("plan_date", { ascending: false })
                    .limit(10)
                    .then(({ data }) => {
                      setLivePlans((data as any[]) || []);
                      setLivePlansLoading(false);
                    });
                }}
                onSelect={(plan) => {
                  // Pravidlo: session_lead je primární, therapist je legacy fallback.
                  // "obe" = spoluvedení Hanka + Káťa, "kata" = Káťa, jinak Hanka.
                  const lead = (plan.session_lead || plan.therapist || "").toLowerCase();
                  const therapistName =
                    lead === "obe" || lead === "obě" || lead === "joint" || lead === "all"
                      ? "Hanka + Káťa"
                      : lead === "kata" || lead === "káťa" || lead === "katka" ? "Káťa" : "Hanka";
                  setLivePlan({
                    id: plan.id,
                    partName: plan.selected_part,
                    therapistName,
                    contextBrief: plan.plan_markdown || "Bez dostupného session briefu.",
                  });
                }}
              />
            )}
          </div>
        )}

        {activeTab === "safety" && (
          <div className="space-y-2">
            <DidSafetyAlerts />
          </div>
        )}

        {activeTab === "tools" && (
          <div className="space-y-2">
            {/* Top-level: explicit full-cycle trigger (proof harness) */}
            <ToolButton
              icon={<Play className={`w-4 h-4 text-primary ${isTriggeringFullCycle ? "animate-pulse" : ""}`} />}
              title="Spustit denní cyklus (full)"
              desc="Plný karel-did-daily-cycle (Fáze 0–10): audit, AI analýza, extrakce, plán, drive flush. Manual run obchází 3h dedup."
              loading={isTriggeringFullCycle}
              onClick={() => { triggerFullCycle(); }}
            />

            {onRefreshMemory && (
              <ToolButton
                icon={<Brain className={`w-4 h-4 text-violet-600 ${isRefreshingMemory ? "animate-pulse" : ""}`} />}
                title="Osvěž paměť"
                desc="POUZE cache: invaliduje did-context-prime cache + nahraje novou situační kartu. NEspouští extrakci."
                loading={isRefreshingMemory}
                onClick={() => { onRefreshMemory(); setOpen(false); }}
              />
            )}

            {onManualUpdate && (
              <ToolButton
                icon={<RefreshCw className={`w-4 h-4 text-primary ${isUpdating ? "animate-spin" : ""}`} />}
                title="Aktualizovat kartotéku (sync)"
                desc="POUZE Drive↔registr sync (kartoteka_DID): nasaje nové karty. NEspouští AI analýzu ani Fázi 4 extrakci."
                loading={isUpdating}
                onClick={() => { onManualUpdate(); setOpen(false); }}
                badge={stats.unprocessedThreads > 0 ? `${stats.unprocessedThreads} vláken` : undefined}
              />
            )}

            {onCentrumSync && (
              <ToolButton
                icon={<ClipboardList className={`w-4 h-4 text-emerald-600 ${isCentrumSyncing ? "animate-pulse" : ""}`} />}
                title="Aktualizovat Centrum (DB→Drive)"
                desc="POUZE flush did_pending_drive_writes do 00_CENTRUM. NEspouští AI analýzu ani extrakci."
                loading={isCentrumSyncing}
                onClick={() => { onCentrumSync(); setOpen(false); }}
              />
            )}

            {onCleanupTasks && (
              <ToolButton
                icon={<Trash2 className={`w-4 h-4 text-amber-600 ${isCleaningTasks ? "animate-pulse" : ""}`} />}
                title="Vyčistit úkoly (DB only)"
                desc="Archivuje not_started úkoly starší 7 dní v did_therapist_tasks. Klientský SQL update."
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

        {activeTab === "wm" && (
          <div className="space-y-2">
            <DidWorkingMemoryPanel />
          </div>
        )}

        {activeTab === "kartoteka" && (
          <div className="space-y-2">
            <DidKartotekaTab />
          </div>
        )}

        {activeTab === "plan" && (
          <div className="space-y-2">
            <DidPlanTab />
          </div>
        )}

        {/* Slice 3A: „crisis" tab block odstraněn (paralelní detail owner). */}

        {activeTab === "memory" && (
          <div className="space-y-2">
            <DidMemoryTab />
          </div>
        )}

        {activeTab === "notes" && (
          <div className="space-y-2">
            <DidTherapistNotes />
          </div>
        )}

        {activeTab === "trends" && (
          <div className="space-y-2">
            <DidTrendsTab />
          </div>
        )}

        {activeTab === "goals" && (
          <div className="space-y-2">
            <DidGoalsTab />
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

/* ── Cycle health bar (truthful: completed vs running, heartbeat age, stuck flag) ── */
function CycleHealthBar({
  health, unprocessedThreads, onReload, onTriggerFullCycle, onResetStuck, isTriggering, isResetting,
}: {
  health: CycleHealth;
  unprocessedThreads: number;
  onReload: () => void;
  onTriggerFullCycle: () => void;
  onResetStuck: () => void;
  isTriggering: boolean;
  isResetting: boolean;
}) {
  const lc = health.lastCompleted;
  const r = health.running;
  const stuck = !!r?.stuck;
  return (
    <div className="rounded-md border border-border bg-muted/40 p-2.5 mb-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold flex items-center gap-1.5">
          <Activity className="w-3 h-3" /> Provoz cyklu
        </span>
        <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={onReload} disabled={health.loading}>
          {health.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Naposled dokončeno:</span>
        <span className="font-medium text-foreground">
          {lc?.completed_at ? formatRelativeTime(lc.completed_at) : "nikdy"}
          {lc?.status === "completed" ? " ✅" : lc?.status === "failed" ? " ❌" : ""}
        </span>
        <span className="text-muted-foreground">Aktuální běh:</span>
        <span className={`font-medium ${stuck ? "text-destructive" : r ? "text-amber-600" : "text-muted-foreground"}`}>
          {r ? `${r.id.slice(0, 8)} (${formatRelativeTime(r.started_at)})` : "žádný"}
        </span>
        {r && (
          <>
            <span className="text-muted-foreground">Fáze:</span>
            <span className="font-medium text-foreground truncate">{r.phase || "—"}</span>
            <span className="text-muted-foreground">Heartbeat age:</span>
            <span className={`font-medium ${stuck ? "text-destructive" : "text-foreground"}`}>
              {formatHeartbeatAge(r.heartbeatAgeSec)}{stuck ? " ⚠️ stuck (>30m)" : ""}
            </span>
          </>
        )}
        {(lc?.last_error || r?.last_error) && (
          <>
            <span className="text-muted-foreground">Last error:</span>
            <span className="font-medium text-destructive truncate" title={r?.last_error || lc?.last_error || ""}>
              {(r?.last_error || lc?.last_error || "").slice(0, 60)}
            </span>
          </>
        )}
        <span className="text-muted-foreground">Nezpracovaná vlákna:</span>
        <span className={`font-medium ${unprocessedThreads > 0 ? "text-amber-600" : "text-foreground"}`}>{unprocessedThreads}</span>
      </div>
      <div className="flex gap-1.5 pt-1">
        <Button size="sm" variant="default" className="h-6 text-[10px] gap-1 flex-1" onClick={onTriggerFullCycle} disabled={isTriggering || (!!r && !stuck)}>
          {isTriggering ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          Spustit denní cyklus
        </Button>
        {r && (
          <Button size="sm" variant={stuck ? "destructive" : "outline"} className="h-6 text-[10px] gap-1" onClick={onResetStuck} disabled={isResetting}>
            {isResetting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
            Force-fail
          </Button>
        )}
      </div>
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

/* ── Live Plan Picker ── */
function LivePlanPicker({ plans, loading, onLoad, onSelect }: {
  plans: Array<{ id: string; selected_part: string; session_lead: string; therapist?: string | null; plan_markdown: string; status: string; plan_date: string }>;
  loading: boolean;
  onLoad: () => void;
  onSelect: (plan: { id: string; selected_part: string; session_lead: string; therapist?: string | null; plan_markdown: string }) => void;
}) {
  useEffect(() => { onLoad(); }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="text-center py-6 space-y-1">
        <p className="text-xs text-muted-foreground">Žádné připravené live sezení.</p>
        <p className="text-[10px] text-muted-foreground/70">Nejdříve vygenerujte session plán v záložce Plán.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Vyberte připravené sezení:</p>
      {plans.map((plan) => (
        <button
          key={plan.id}
          onClick={() => onSelect(plan)}
          className="w-full text-left p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors space-y-1"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">{plan.selected_part}</span>
            <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
              {(() => {
                // session_lead primárně, therapist legacy fallback
                const lead = (plan.session_lead || plan.therapist || "").toLowerCase();
                if (lead === "obe" || lead === "obě" || lead === "joint" || lead === "all") return "Hanka + Káťa";
                if (lead === "kata" || lead === "káťa" || lead === "katka") return "Káťa";
                return "Hanka";
              })()}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{plan.plan_date}</span>
            <span>·</span>
            <span>{plan.status}</span>
          </div>
          {plan.plan_markdown && (
            <p className="text-[10px] text-muted-foreground/80 line-clamp-2">{plan.plan_markdown.slice(0, 120)}…</p>
          )}
        </button>
      ))}
    </div>
  );
}

export default DidSprava;
