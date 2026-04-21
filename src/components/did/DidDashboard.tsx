import { useCallback, useEffect, useState } from "react";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import { Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isNonDidEntity } from "@/lib/didPartNaming";
import type { DidSubMode } from "./DidSubModeSelector";
// Final Pracovna Cleanup Verdict (2026-04-21):
//   - `CommandCrisisCard` ODPOJEN — `CrisisAlert` (sticky banner) je
//     jediný owner krizové signalizace na Pracovna. Operativní obsah
//     (missing/requires/CTA) je dostupný přes `CrisisDetailWorkspace`
//     (klik z banneru). Komponenta `CommandCrisisCard` se v projektu
//     nemaže — jen se nerenderuje na této obrazovce.
//   - `OpsSnapshotBar` ODPOJEN — counter strip („99+ urgentní",
//     „k archivaci", „live plány") je noise, ne decision layer.
//     Může být přesunutý do Admin/inspect vrstvy v jiném passu.
//   - `KarelDailyPlan` + `DailyDecisionTasks` + `KarelCrisisDeficits`
//     odstraněny v dřívějších passech. Briefing je single decision owner.
import DidDailySessionPlan from "./DidDailySessionPlan";
import TeamDeliberationsPanel from "./TeamDeliberationsPanel";
import DeliberationRoom from "./DeliberationRoom";
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

const todayISO = () => pragueTodayISO();

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
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  accent?: "crisis" | "gold" | "warning";
} & React.HTMLAttributes<HTMLDivElement>) => {
  const borderLeft =
    accent === "crisis"
      ? "border-l-[3px] border-l-destructive"
      : accent === "gold"
        ? "border-l-[3px] border-l-primary"
        : accent === "warning"
          ? "border-l-[3px] border-l-accent"
          : "";

  return <div className={cn("jung-card p-5", borderLeft, className)} {...rest}>{children}</div>;
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
  // ── Crisis priority is now driven by snapshot.command.crises (canonical from
  //    crisis_events). The old useCrisisOperationalState path is intentionally
  //    NOT used here so KarelDailyPlan never receives a stale hasCrisisBanner.
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  // Slice 3A (2026-04-21): admin state (bootstrapping/auditing/reformatting/
  // centrumSyncing/cleaningTasks) přesunut do `AdminSpravaLauncher`. Pracovna
  // je teď čistá od admin tooling.
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date>(new Date());
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [openDeliberationId, setOpenDeliberationId] = useState<string | null>(null);

  // SLICE 2: deep-link bridge z Chat.tsx (?deliberation_id=<id>) — Chat handler
  // přepne na DID dashboard a uloží ID do sessionStorage. Tento effect ho
  // přečte a otevře DeliberationRoom. Po přečtení klíč mažeme, aby remount
  // dashboardu nezakopl o starý ID.
  useEffect(() => {
    try {
      const pendingId = sessionStorage.getItem("karel_open_deliberation_id");
      if (pendingId) {
        sessionStorage.removeItem("karel_open_deliberation_id");
        setOpenDeliberationId(pendingId);
      }
    } catch { /* ignore */ }
  }, []);

  // ── Daily snapshot loader (Prague-day cache, fallback on error) ──
  const loadSnapshot = useCallback(async (force = false) => {
    try {
      const { data: u } = await supabase.auth.getUser();
      const userId = u?.user?.id || "anon";
      const today = pragueTodayISO();
      const cacheKey = `karel-command:${userId}:${today}`;

      if (!force) {
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            // Only accept cache if it matches today's Prague day.
            if (parsed?.snapshot && (!parsed.pragueDate || parsed.pragueDate === today)) {
              setSnapshot(parsed.snapshot);
            }
          }
        } catch {
          /* ignore corrupted cache */
        }
      }

      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ mode: "snapshot", date: today, trigger: force ? "manual" : "auto" }),
        },
      );
      if (!resp.ok) throw new Error(`snapshot ${resp.status}`);
      const json = await resp.json();
      if (json?.snapshot) {
        setSnapshot(json.snapshot);
        try {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              snapshot: json.snapshot,
              pragueDate: today,
              cachedAt: Date.now(),
            }),
          );
        } catch {
          /* quota exceeded — ignore */
        }
      }
    } catch (e) {
      console.warn("[DidDashboard] snapshot load failed, using cache if any", e);
    }
  }, []);

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

  // ── Unified refresh: dashboard data + snapshot always move together.
  //    Used for initial load, interval, realtime handlers and manual refresh.
  const refreshAll = useCallback(
    async (opts: { silent?: boolean; force?: boolean } = {}) => {
      const { silent = false, force = false } = opts;
      await Promise.all([loadDashboardData(silent), loadSnapshot(force)]);
    },
    [loadDashboardData, loadSnapshot],
  );

  // Initial load + manual refresh trigger
  useEffect(() => {
    refreshAll({ force: refreshTrigger > 0 });
  }, [refreshAll, refreshTrigger]);

  // Interval polling — silent + uses cache, but still keeps snapshot fresh
  useEffect(() => {
    const interval = setInterval(() => {
      refreshAll({ silent: true });
    }, 60000);
    return () => clearInterval(interval);
  }, [refreshAll]);

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
          refreshAll({ silent: true, force: true });
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
          refreshAll({ silent: true, force: true });
        },
      )
      .subscribe();

    const crisisEventsChannel = supabase
      .channel("dashboard-crisis-events")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisis_events" },
        () => {
          refreshAll({ silent: true, force: true });
        },
      )
      .subscribe();

    setRealtimeConnected(true);

    return () => {
      setRealtimeConnected(false);
      supabase.removeChannel(alertChannel);
      supabase.removeChannel(crisisChannel);
      supabase.removeChannel(crisisEventsChannel);
    };
  }, [refreshAll]);

  // Slice 3A (2026-04-21): runDidBootstrap / runHealthAudit / runReformat /
  // runCentrumSync / runCleanupTasks přesunuty do AdminSpravaLauncher
  // (DidContentRouter → AdminSurface). Pracovna je čistá.


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
        {/* Final Pracovna Cleanup Verdict (2026-04-21):
            - CommandCrisisCard ODPOJEN — duplicita s CrisisAlert bannerem.
              Operativní detail krizí dostupný přes CrisisDetailWorkspace.
            - OpsSnapshotBar ODPOJEN — counter strip přesunut mimo Pracovna.
            - Pracovna teď renderuje jen porady + dnešní sezení. Briefing
              vlastní KarelOverviewPanel (nadřazený layout). */}

        {/* ── BLOCK 1 — TEAM DELIBERATIONS (společná porada týmu) ── */}
        <StudyCard className="space-y-3" data-pracovna-anchor="team-deliberations">
          <ErrorBoundary fallbackTitle="Porada týmu selhala">
            <TeamDeliberationsPanel
              refreshTrigger={refreshTrigger}
              onOpenRoom={(id) => setOpenDeliberationId(id)}
            />
          </ErrorBoundary>
        </StudyCard>

        {/* ── BLOCK 2 — DNEŠNÍ SEZENÍ ── */}
        <StudyCard className="space-y-4" data-pracovna-anchor="today-session-plan">
          <SectionTitle icon={<Clock className="h-4 w-4 text-primary" />}>Dnes</SectionTitle>

          <div className="max-h-[22rem] overflow-auto pr-1">
            <ErrorBoundary fallbackTitle="Plán sezení selhal">
              <DidDailySessionPlan refreshTrigger={refreshTrigger} />
            </ErrorBoundary>
          </div>
        </StudyCard>
      </div>

      <DeliberationRoom
        deliberationId={openDeliberationId}
        onClose={() => setOpenDeliberationId(null)}
      />
    </div>
  );
};

export default DidDashboard;
