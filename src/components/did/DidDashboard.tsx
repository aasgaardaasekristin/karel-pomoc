import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, ListChecks, Upload, RefreshCw, Users, Video } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import { KarelBadge } from "@/components/ui/KarelBadge";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import type { DidSubMode } from "./DidSubModeSelector";
import DidSystemMap from "./DidSystemMap";
import DidDailySessionPlan from "./DidDailySessionPlan";
import DidSystemOverview from "./DidSystemOverview";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidPulseCheck from "./DidPulseCheck";
import DidColleagueView from "./DidColleagueView";
import DidCoordinationAlerts from "./DidCoordinationAlerts";
import DidSprava from "./DidSprava";
import DidSupervisionReport from "./DidSupervisionReport";
import DidSwitchHistory from "./DidSwitchHistory";
import ErrorBoundary from "@/components/ErrorBoundary";

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
  onRefreshMemory?: () => void;
  isRefreshingMemory?: boolean;
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--text-tertiary))] mb-3">
    {children}
  </h3>
);

const DidDashboard = ({ onManualUpdate, isUpdating, syncProgress, onQuickThread, onRefreshMemory, isRefreshingMemory }: Props) => {
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [pendingWriteCount, setPendingWriteCount] = useState(0);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [isCentrumSyncing, setIsCentrumSyncing] = useState(false);
  const [isCleaningTasks, setIsCleaningTasks] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      const [threadsRes, pendingWritesRes] = await Promise.all([
        supabase
          .from("did_threads")
          .select("id, part_name, last_activity_at, messages")
          .eq("sub_mode", "cast")
          .order("last_activity_at", { ascending: false }),
        supabase
          .from("did_pending_drive_writes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
      ]);

      const threads = threadsRes.data || [];
      const now = Date.now();
      const latestByPart = new Map<string, ActiveThreadSummary>();
      const partRows: PartActivity[] = [];

      for (const thread of threads) {
        const lastSeen = thread.last_activity_at || null;
        const diffDays = lastSeen ? (now - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24) : Number.POSITIVE_INFINITY;
        const status: PartActivity["status"] = diffDays <= 1 ? "active" : diffDays > 7 ? "warning" : "sleeping";

        if (!latestByPart.has(thread.part_name)) {
          latestByPart.set(thread.part_name, {
            id: thread.id,
            partName: thread.part_name,
            lastActivityAt: thread.last_activity_at,
            messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
          });
          partRows.push({ name: thread.part_name, lastSeen, status });
        }
      }

      setParts(partRows);
      setActiveThreads(Array.from(latestByPart.values()));
      setPendingWriteCount(pendingWritesRes.count || 0);
    } catch (error) {
      console.error("Failed to load DID dashboard data:", error);
      toast.error("Nepodařilo se načíst DID dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboardData(); }, [loadDashboardData, refreshTrigger]);

  const runDidBootstrap = useCallback(async () => {
    setIsBootstrapping(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-memory-bootstrap`,
        { method: "POST", headers, body: JSON.stringify({ phase: "scan" }) }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Bootstrap selhal");
      toast.success("Bootstrap DID paměti spuštěn");
      setRefreshTrigger((prev) => prev + 1);
    } catch (error: any) {
      console.error("Bootstrap failed:", error);
      toast.error(error?.message || "Bootstrap DID paměti selhal");
    } finally {
      setIsBootstrapping(false);
    }
  }, []);

  const runHealthAudit = useCallback(async () => {
    setIsAuditing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-kartoteka-health`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      toast.error("Audit kartotéky selhal");
    } finally {
      setIsAuditing(false);
    }
  }, []);

  const runReformat = useCallback(async () => {
    setIsReformatting(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Přeformátováno: ${data.reformatted || 0} karet`);
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      toast.error("Přeformátování selhalo");
    } finally {
      setIsReformatting(false);
    }
  }, []);

  const runCentrumSync = useCallback(async () => {
    setIsCentrumSyncing(true);
    try {
      const headers = await getAuthHeaders();
      const today = new Date().toISOString().slice(0, 10);

      // Run Centrum sync + dashboard + plan in parallel
      const [centrumResp, dashboardResp] = await Promise.allSettled([
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-centrum-sync`,
          { method: "POST", headers, body: JSON.stringify({}) }
        ),
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`,
          { method: "POST", headers, body: JSON.stringify({ date: today, trigger: "manual" }) }
        ),
      ]);

      const results: string[] = [];
      if (centrumResp.status === "fulfilled" && centrumResp.value.ok) {
        const data = await centrumResp.value.json();
        results.push(data.summary || "Centrum ✅");
      } else {
        results.push("Centrum ❌");
      }
      if (dashboardResp.status === "fulfilled" && dashboardResp.value.ok) {
        results.push("Dashboard ✅");
      }

      toast.success(results.join(" | "));
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      console.error("Centrum sync failed:", e);
      toast.error("Synchronizace Centra selhala");
    } finally {
      setIsCentrumSyncing(false);
    }
  }, []);

  const runCleanupTasks = useCallback(async () => {
    setIsCleaningTasks(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("did_therapist_tasks")
        .update({ status: "archived" } as any)
        .in("status", ["not_started", "pending"] as any)
        .lt("created_at", sevenDaysAgo)
        .select("id");
      if (error) throw error;
      const count = data?.length || 0;
      toast.success(`Archivováno ${count} starých úkolů`);
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      console.error("Cleanup tasks failed:", e);
      toast.error("Čištění úkolů selhalo");
    } finally {
      setIsCleaningTasks(false);
    }
  }, []);

  const warningParts = useMemo(() => parts.filter((part) => part.status === "warning"), [parts]);

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6 space-y-6" data-no-swipe-back="true">
      {/* Správa */}
      <div className="flex justify-end">
        <DidSprava
          onBootstrap={runDidBootstrap}
          isBootstrapping={isBootstrapping}
          onHealthAudit={runHealthAudit}
          isAuditing={isAuditing}
          onReformat={runReformat}
          isReformatting={isReformatting}
          onManualUpdate={onManualUpdate}
          isUpdating={isUpdating}
          onCentrumSync={runCentrumSync}
          isCentrumSyncing={isCentrumSyncing}
          onCleanupTasks={runCleanupTasks}
          isCleaningTasks={isCleaningTasks}
          onRefreshMemory={onRefreshMemory}
          isRefreshingMemory={isRefreshingMemory}
          refreshTrigger={refreshTrigger}
          onSelectPart={onQuickThread ? (partName) => onQuickThread("", partName) : undefined}
        />
      </div>

      {/* System Overview */}
      <ErrorBoundary fallbackTitle="Přehled systému selhal">
        <KarelCard variant="default" padding="md" className="border-l-4 border-l-[hsl(var(--accent-primary))]">
          <DidSystemOverview refreshTrigger={refreshTrigger} onTasksSynced={() => setRefreshTrigger((prev) => prev + 1)} />
        </KarelCard>
      </ErrorBoundary>

      {/* Daily Session Plan */}
      <ErrorBoundary fallbackTitle="Denní plán selhal">
        <DidDailySessionPlan refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* Tasks */}
      <section>
        <SectionLabel>Úkoly pro terapeutky</SectionLabel>
        <KarelCard variant="default" padding="md">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ListChecks size={14} className="text-[hsl(var(--accent-primary))]" />
              <span className="text-sm font-medium text-[hsl(var(--text-primary))]">Task Board</span>
            </div>
            {pendingWriteCount > 0 && (
              <KarelBadge variant="warning" size="sm" dot>
                <Upload size={10} /> {pendingWriteCount} čeká na Drive
              </KarelBadge>
            )}
          </div>
          <ErrorBoundary fallbackTitle="Task board selhal">
            <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
          </ErrorBoundary>
        </KarelCard>
      </section>

      {/* Agreements */}
      <ErrorBoundary fallbackTitle="Dohody selhaly">
        <KarelCard variant="default" padding="md">
          <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger((prev) => prev + 1)} />
        </KarelCard>
      </ErrorBoundary>

      {/* Monthly */}
      <ErrorBoundary fallbackTitle="Měsíční panel selhal">
        <KarelCard variant="default" padding="md">
          <DidMonthlyPanel refreshTrigger={refreshTrigger} />
        </KarelCard>
      </ErrorBoundary>

      {/* Pulse Check */}
      <ErrorBoundary fallbackTitle="Pulse check selhal">
        <DidPulseCheck refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* Coordination Alerts */}
      <ErrorBoundary fallbackTitle="Koordinační upozornění selhala">
        <DidCoordinationAlerts refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* Supervision Report */}
      <ErrorBoundary fallbackTitle="Supervizní report selhal">
        <DidSupervisionReport refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* Switch History */}
      <ErrorBoundary fallbackTitle="Switch historie selhala">
        <DidSwitchHistory refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* Colleague View */}
      <ErrorBoundary fallbackTitle="Pohled kolegyně selhal">
        <DidColleagueView refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* System Map */}
      {!loading && parts.length > 0 && (
        <ErrorBoundary fallbackTitle="Mapa systému selhala">
          <DidSystemMap
            parts={parts}
            activeThreads={activeThreads}
            onQuickThread={onQuickThread}
            onDeletePart={async (partName) => {
              const { error } = await supabase
                .from("did_threads")
                .delete()
                .eq("part_name", partName)
                .eq("sub_mode", "cast");

              if (error) {
                toast.error(`Nepodařilo se smazat vlákna pro ${partName}`);
                return;
              }

              toast.success(`Vlákna pro „${partName}" smazána z mapy`);
              setParts((prev) => prev.filter((part) => part.name !== partName));
              setActiveThreads((prev) => prev.filter((thread) => thread.partName !== partName));
            }}
          />
        </ErrorBoundary>
      )}

      {/* Warning parts */}
      {warningParts.length > 0 && (
        <KarelCard variant="outlined" padding="md">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={16} className="text-[hsl(var(--accent-primary))]" />
            <span className="text-sm font-medium text-[hsl(var(--text-primary))]">Upozornění na neaktivní části</span>
          </div>
          <p className="text-xs text-[hsl(var(--text-secondary))]">
            {warningParts.map((part) => part.name).join(", ")} – neaktivní více než 7 dní. Zvažte oslovení.
          </p>
        </KarelCard>
      )}

      {/* Admin tools */}
      <section>
        <SectionLabel>Správa</SectionLabel>
        <div className="flex flex-wrap gap-2">
          <KarelButton
            variant="secondary"
            size="sm"
            loading={isRefreshingMemory}
            onClick={onRefreshMemory}
            icon={<RefreshCw size={14} />}
          >
            Osvěž paměť
          </KarelButton>
          <KarelButton
            variant="secondary"
            size="sm"
            loading={isUpdating}
            onClick={onManualUpdate}
            icon={<Upload size={14} />}
          >
            Manuální aktualizace
          </KarelButton>
        </div>
      </section>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-8 text-sm text-[hsl(var(--text-tertiary))]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Načítám dashboard…
        </div>
      )}
    </div>
  );
};

export default DidDashboard;
