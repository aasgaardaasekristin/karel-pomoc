import { useCallback, useEffect, useState } from "react";
import { useCrisisOperationalState } from "@/hooks/useCrisisOperationalState";
import { Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isNonDidEntity } from "@/lib/didPartNaming";
import type { DidSubMode } from "./DidSubModeSelector";
import KarelDailyPlan from "./KarelDailyPlan";
import DidDailySessionPlan from "./DidDailySessionPlan";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidSprava from "./DidSprava";
import PendingQuestionsPanel from "./PendingQuestionsPanel";
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

const todayISO = () => new Date().toISOString().slice(0, 10);

const playAlertSound = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.frequency.value = 800;
    oscillator.type = "sine";
    gainNode.gain.value = 0.3;
    oscillator.start();
    setTimeout(() => {
      gainNode.gain.value = 0;
    }, 150);
    setTimeout(() => {
      gainNode.gain.value = 0.3;
    }, 250);
    setTimeout(() => {
      gainNode.gain.value = 0;
      oscillator.stop();
      audioCtx.close();
    }, 400);
  } catch {
    /* Audio not available */
  }
};

const StudyCard = ({
  children,
  className,
  accent,
}: {
  children: React.ReactNode;
  className?: string;
  accent?: "crisis" | "gold" | "warning";
}) => {
  const borderLeft =
    accent === "crisis"
      ? "border-l-[3px] border-l-destructive"
      : accent === "gold"
        ? "border-l-[3px] border-l-primary"
        : accent === "warning"
          ? "border-l-[3px] border-l-accent"
          : "";

  return <div className={cn("jung-card p-5", borderLeft, className)}>{children}</div>;
};

const SectionTitle = ({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) => (
  <h3 className="jung-section-title mb-4 flex items-center gap-2.5 text-[17px]">
    {icon}
    {children}
  </h3>
);

const DidDashboard = ({
  onManualUpdate,
  isUpdating,
  onQuickThread,
  onRefreshMemory,
  isRefreshingMemory,
}: Props) => {
  const { cards: crisisCards } = useCrisisOperationalState();
  const hasCrisisBanner = crisisCards.length > 0;
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [isCentrumSyncing, setIsCentrumSyncing] = useState(false);
  const [isCleaningTasks, setIsCleaningTasks] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date>(new Date());
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  const loadDashboardData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);

    try {
      const [threadsRes, registryRes] = await Promise.all([
        supabase
          .from("did_threads")
          .select("id, part_name, last_activity_at, messages, sub_mode")
          .in("sub_mode", ["cast", "crisis"])
          .order("last_activity_at", { ascending: false }),
        (supabase as any)
          .from("did_part_registry")
          .select("part_name, status, last_seen_at")
          .in("status", ["active", "crisis", "stabilizing"]),
      ]);

      const registryRows = ((registryRes.data as any[]) || []).filter(
        (row) => !isNonDidEntity(row.part_name || ""),
      );
      const activeRegistryNames = new Set(
        registryRows.map((row) => String(row.part_name || "").toUpperCase()),
      );

      const threads = ((threadsRes.data as any[]) || []).filter(
        (thread) =>
          !isNonDidEntity(thread.part_name || "") &&
          activeRegistryNames.has(String(thread.part_name || "").toUpperCase()),
      );

      const latestByPart = new Map<string, ActiveThreadSummary>();
      const threadsByPart = new Map<string, any[]>();

      for (const thread of threads) {
        const key = String(thread.part_name || "").toUpperCase();
        const bucket = threadsByPart.get(key) || [];
        bucket.push(thread);
        threadsByPart.set(key, bucket);
      }

      for (const [partKey, bucket] of threadsByPart.entries()) {
        const sortedBucket = [...bucket].sort(
          (a, b) =>
            new Date(b.last_activity_at || 0).getTime() - new Date(a.last_activity_at || 0).getTime(),
        );
        const mostRecent = sortedBucket[0];
        latestByPart.set(partKey, {
          id: mostRecent.id,
          partName: mostRecent.part_name,
          lastActivityAt: mostRecent.last_activity_at,
          messageCount: Array.isArray(mostRecent.messages) ? mostRecent.messages.length : 0,
        });
      }

      const nextParts: PartActivity[] = registryRows
        .map((row) => {
          const latest = latestByPart.get(String(row.part_name || "").toUpperCase());
          const lastSeen = latest?.lastActivityAt || row.last_seen_at || null;
          const diffDays = lastSeen
            ? (Date.now() - new Date(lastSeen).getTime()) / 86400000
            : Number.POSITIVE_INFINITY;

          const status: PartActivity["status"] =
            row.status === "stabilizing"
              ? "warning"
              : diffDays <= 3
                ? "active"
                : "sleeping";

          return {
            name: row.part_name,
            lastSeen,
            status,
          };
        })
        .sort((a, b) => {
          const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
          const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
          return bTime - aTime;
        });

      setParts(nextParts);
      setActiveThreads(
        Array.from(latestByPart.values()).sort(
          (a, b) => new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime(),
        ),
      );
      setLastRefreshAt(new Date());
    } catch (error) {
      console.error("Failed to load DID dashboard data:", error);
      toast.error("Nepodařilo se načíst DID dashboard");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData, refreshTrigger]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadDashboardData(true);
    }, 60000);
    return () => clearInterval(interval);
  }, [loadDashboardData]);

  useEffect(() => {
    const alertChannel = supabase
      .channel("dashboard-safety-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "safety_alerts" },
        (payload: any) => {
          const severity = payload.new?.severity;
          const partName = payload.new?.part_name;
          if (severity === "critical") {
            playAlertSound();
            toast.error(`🚨 KRITICKÝ ALERT: ${payload.new?.alert_type} — ${partName || "?"}`, {
              duration: 15000,
            });
          }
          loadDashboardData(true);
        },
      )
      .subscribe();

    const crisisChannel = supabase
      .channel("dashboard-crisis")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisis_alerts" },
        (payload: any) => {
          if (payload.eventType === "INSERT") {
            playAlertSound();
            toast.error(`🔴 NOVÁ KRIZE: ${payload.new?.part_name || "?"}`, { duration: 20000 });
          }
          loadDashboardData(true);
        },
      )
      .subscribe();

    setRealtimeConnected(true);

    return () => {
      setRealtimeConnected(false);
      supabase.removeChannel(alertChannel);
      supabase.removeChannel(crisisChannel);
    };
  }, [loadDashboardData]);

  const runDidBootstrap = useCallback(async () => {
    setIsBootstrapping(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-memory-bootstrap`, {
        method: "POST",
        headers,
        body: JSON.stringify({ phase: "scan" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Bootstrap selhal");
      toast.success("Bootstrap DID paměti spuštěn");
      setRefreshTrigger((prev) => prev + 1);
    } catch (error: any) {
      toast.error(error?.message || "Bootstrap DID paměti selhal");
    } finally {
      setIsBootstrapping(false);
    }
  }, []);

  const runHealthAudit = useCallback(async () => {
    setIsAuditing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-kartoteka-health`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      setRefreshTrigger((prev) => prev + 1);
    } catch {
      toast.error("Audit kartotéky selhal");
    } finally {
      setIsAuditing(false);
    }
  }, []);

  const runReformat = useCallback(async () => {
    setIsReformatting(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Přeformátováno: ${data.reformatted || 0} karet`);
      setRefreshTrigger((prev) => prev + 1);
    } catch {
      toast.error("Přeformátování selhalo");
    } finally {
      setIsReformatting(false);
    }
  }, []);

  const runCentrumSync = useCallback(async () => {
    setIsCentrumSyncing(true);
    try {
      const headers = await getAuthHeaders();
      const today = todayISO();
      const [centrumResp, dashboardResp] = await Promise.allSettled([
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-centrum-sync`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        }),
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`, {
          method: "POST",
          headers,
          body: JSON.stringify({ date: today, trigger: "manual" }),
        }),
      ]);

      const results: string[] = [];
      if (centrumResp.status === "fulfilled" && centrumResp.value.ok) {
        const data = await centrumResp.value.json();
        results.push(data.summary || "Centrum ✅");
      } else {
        results.push("Centrum ❌");
      }
      if (dashboardResp.status === "fulfilled" && dashboardResp.value.ok) results.push("Dashboard ✅");
      toast.success(results.join(" | "));
      setRefreshTrigger((prev) => prev + 1);
    } catch {
      toast.error("Synchronizace Centra selhala");
    } finally {
      setIsCentrumSyncing(false);
    }
  }, []);

  const runCleanupTasks = useCallback(async () => {
    setIsCleaningTasks(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("did_therapist_tasks")
        .update({ status: "archived" } as any)
        .in("status", ["not_started", "pending"] as any)
        .lt("created_at", sevenDaysAgo)
        .select("id");
      if (error) throw error;
      toast.success(`Archivováno ${data?.length || 0} starých úkolů`);
      setRefreshTrigger((prev) => prev + 1);
    } catch {
      toast.error("Čištění úkolů selhalo");
    } finally {
      setIsCleaningTasks(false);
    }
  }, []);


  if (loading) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-[900px] space-y-6 px-4 py-6">
          <div className="h-10 w-full animate-pulse rounded-2xl" style={{ background: "hsl(var(--muted))" }} />
          <div className="h-40 w-full animate-pulse rounded-2xl" style={{ background: "hsl(var(--muted))" }} />
          <div className="h-32 w-full animate-pulse rounded-2xl" style={{ background: "hsl(var(--muted))" }} />
          <div className="h-24 w-full animate-pulse rounded-2xl" style={{ background: "hsl(var(--muted))" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" data-no-swipe-back="true">
      <div className="relative z-10 mx-auto max-w-[900px] space-y-4 px-4 py-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted-foreground">
              {lastRefreshAt.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <div className="flex items-center gap-1">
              <div
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  realtimeConnected ? "bg-primary" : "bg-muted-foreground/40",
                )}
              />
              <span className="text-[11px] text-muted-foreground">
                {realtimeConnected ? "live" : "offline"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-3 text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() => setRefreshTrigger((prev) => prev + 1)}
            >
              <RefreshCw className="h-3 w-3" /> Obnovit
            </Button>
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
        </div>

        <div className="jung-hero-section rounded-2xl p-1">
          <ErrorBoundary fallbackTitle="Denní plán selhal">
            <KarelDailyPlan refreshTrigger={refreshTrigger} hasCrisisBanner={hasCrisisBanner} />
          </ErrorBoundary>
        </div>

        <StudyCard className="space-y-4">
          <SectionTitle icon={<Clock className="h-4 w-4 text-primary" />}>Dnes</SectionTitle>

          <div className="max-h-[22rem] overflow-auto pr-1">
            <ErrorBoundary fallbackTitle="Plán sezení selhal">
              <DidDailySessionPlan refreshTrigger={refreshTrigger} />
            </ErrorBoundary>
          </div>

          <div className="max-h-[24rem] overflow-auto pr-1">
            <ErrorBoundary fallbackTitle="Task board selhal">
              <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
            </ErrorBoundary>
          </div>

          <div className="max-h-64 overflow-auto pr-1">
            <ErrorBoundary fallbackTitle="Otázky selhaly">
              <PendingQuestionsPanel refreshTrigger={refreshTrigger} />
            </ErrorBoundary>
          </div>
        </StudyCard>

        <div className="rounded-xl bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
          <span>
            Části: <strong className="text-foreground">{parts.filter((part) => part.status === "active").length}</strong> aktivních
          </span>
          <span className="mx-2">•</span>
          <span>
            Vlákna: <strong className="text-foreground">{activeThreads.length}</strong>
          </span>
        </div>
      </div>
    </div>
  );
};

export default DidDashboard;
