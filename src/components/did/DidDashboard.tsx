import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, ListChecks, Upload, RefreshCw, Shield, MessageSquare, Heart, Target, ShieldCheck, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isNonDidEntity, cleanDisplayName } from "@/lib/didPartNaming";
import type { DidSubMode } from "./DidSubModeSelector";
import DidSystemMap from "./DidSystemMap";
import KarelDailyPlan from "./KarelDailyPlan";
import DidDailySessionPlan from "./DidDailySessionPlan";
// DidSystemOverview removed from main view — 05A briefing in KarelDailyPlan is the primary source
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidColleagueView from "./DidColleagueView";
import DidCoordinationAlerts from "./DidCoordinationAlerts";
import DidSprava from "./DidSprava";
import DidSupervisionReport from "./DidSupervisionReport";
import DidSwitchHistory from "./DidSwitchHistory";
import CrisisTimeline from "./CrisisTimeline";
import PendingQuestionsPanel from "./PendingQuestionsPanel";
import ErrorBoundary from "@/components/ErrorBoundary";

// ── Types ──
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

// Skeleton
const SkeletonBlock = ({ className }: { className?: string }) => (
  <div className={cn("animate-pulse rounded-xl bg-gray-100", className)} />
);

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
    setTimeout(() => { gainNode.gain.value = 0; }, 150);
    setTimeout(() => { gainNode.gain.value = 0.3; }, 250);
    setTimeout(() => { gainNode.gain.value = 0; oscillator.stop(); audioCtx.close(); }, 400);
  } catch { /* Audio not available */ }
};

const DidDashboard = ({ onManualUpdate, isUpdating, syncProgress, onQuickThread, onRefreshMemory, isRefreshingMemory }: Props) => {
  const navigate = useNavigate();
  const { cards: crisisCards } = useCrisisOperationalState();
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
  const [lastRefreshAt, setLastRefreshAt] = useState<Date>(new Date());
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [healthIssues, setHealthIssues] = useState<any[]>([]);
  const [showCrisisDetail, setShowCrisisDetail] = useState(false);

  const loadDashboardData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const today = todayISO();
      const todayStart = today + "T00:00:00";

      const results = await Promise.all([
        supabase.from("did_threads").select("id, part_name, last_activity_at, messages, sub_mode").in("sub_mode", ["cast", "crisis"]).order("last_activity_at", { ascending: false }),
        supabase.from("did_pending_drive_writes").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("did_part_registry").select("part_name, display_name, status, role_in_system, last_seen_at, known_strengths, known_triggers").eq("status", "active"),
        supabase.from("system_health_log").select("id, event_type, severity, message, created_at").eq("severity", "critical").eq("resolved", false).order("created_at", { ascending: false }).limit(10),
      ]);
      const [threadsRes, pendingWritesRes, registryRes, healthRes] = results as any;

      setHealthIssues(healthRes.data || []);

      // Process threads
      const threads = (threadsRes.data || []).filter((t: any) => !isNonDidEntity(t.part_name || ""));
      const partRows: PartActivity[] = [];
      const latestByPart = new Map<string, ActiveThreadSummary>();
      const threadsByPart = new Map<string, typeof threads>();
      for (const thread of threads) {
        const key = (thread.part_name || "").toUpperCase();
        const bucket = threadsByPart.get(key) || [];
        bucket.push(thread);
        threadsByPart.set(key, bucket);
      }
      const bestActivityByPart = new Map<string, { thread: typeof threads[0]; diffDays: number }>();
      for (const thread of threads) {
        const key = thread.part_name.toUpperCase();
        const lastSeen = thread.last_activity_at || null;
        const diffDays = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) / 86400000 : Infinity;
        const existing = bestActivityByPart.get(key);
        if (!existing || diffDays < existing.diffDays) bestActivityByPart.set(key, { thread, diffDays });
      }
      for (const [, { thread }] of bestActivityByPart) {
        const allForPart = threadsByPart.get(thread.part_name.toUpperCase()) || [thread];
        const mostRecent = Math.max(...allForPart.map(t => new Date(t.last_activity_at || 0).getTime()));
        const days = Number.isFinite(mostRecent) ? (Date.now() - mostRecent) / 86400000 : Infinity;
        const status: PartActivity["status"] = days <= 1 ? "active" : days > 7 ? "warning" : "sleeping";
        latestByPart.set(thread.part_name.toUpperCase(), { id: thread.id, partName: thread.part_name, lastActivityAt: thread.last_activity_at, messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0 });
        partRows.push({ name: thread.part_name, lastSeen: thread.last_activity_at || null, status });
      }
      setParts(partRows);
      setActiveThreads(Array.from(latestByPart.values()));
      setPendingWriteCount(pendingWritesRes.count || 0);

      setLastRefreshAt(new Date());
    } catch (error) {
      console.error("Failed to load DID dashboard data:", error);
      toast.error("Nepodařilo se načíst DID dashboard");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboardData(); }, [loadDashboardData, refreshTrigger]);
  useEffect(() => {
    const interval = setInterval(() => { loadDashboardData(true); }, 60000);
    return () => clearInterval(interval);
  }, [loadDashboardData]);

  // Realtime
  useEffect(() => {
    const alertChannel = supabase
      .channel("dashboard-safety-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "safety_alerts" }, (payload: any) => {
        const severity = payload.new?.severity;
        const partName = payload.new?.part_name;
        if (severity === "critical") {
          playAlertSound();
          toast.error(`🚨 KRITICKÝ ALERT: ${payload.new?.alert_type} — ${partName || "?"}`, { duration: 15000 });
        }
        loadDashboardData(true);
      })
      .subscribe();

    const crisisChannel = supabase
      .channel("dashboard-crisis")
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_alerts" }, (payload: any) => {
        if (payload.eventType === "INSERT") {
          playAlertSound();
          toast.error(`🔴 NOVÁ KRIZE: ${payload.new?.part_name || "?"}`, { duration: 20000 });
        }
        loadDashboardData(true);
      })
      .subscribe();

    setRealtimeConnected(true);
    return () => {
      setRealtimeConnected(false);
      supabase.removeChannel(alertChannel);
      supabase.removeChannel(crisisChannel);
    };
  }, [loadDashboardData]);

  // Action callbacks
  const runDidBootstrap = useCallback(async () => {
    setIsBootstrapping(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-memory-bootstrap`, { method: "POST", headers, body: JSON.stringify({ phase: "scan" }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Bootstrap selhal");
      toast.success("Bootstrap DID paměti spuštěn");
      setRefreshTrigger(p => p + 1);
    } catch (error: any) { toast.error(error?.message || "Bootstrap DID paměti selhal"); }
    finally { setIsBootstrapping(false); }
  }, []);

  const runHealthAudit = useCallback(async () => {
    setIsAuditing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-kartoteka-health`, { method: "POST", headers, body: JSON.stringify({}) });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      setRefreshTrigger(p => p + 1);
    } catch { toast.error("Audit kartotéky selhal"); }
    finally { setIsAuditing(false); }
  }, []);

  const runReformat = useCallback(async () => {
    setIsReformatting(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`, { method: "POST", headers, body: JSON.stringify({}) });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Přeformátováno: ${data.reformatted || 0} karet`);
      setRefreshTrigger(p => p + 1);
    } catch { toast.error("Přeformátování selhalo"); }
    finally { setIsReformatting(false); }
  }, []);

  const runCentrumSync = useCallback(async () => {
    setIsCentrumSyncing(true);
    try {
      const headers = await getAuthHeaders();
      const today = todayISO();
      const [centrumResp, dashboardResp] = await Promise.allSettled([
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-centrum-sync`, { method: "POST", headers, body: JSON.stringify({}) }),
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`, { method: "POST", headers, body: JSON.stringify({ date: today, trigger: "manual" }) }),
      ]);
      const results: string[] = [];
      if (centrumResp.status === "fulfilled" && centrumResp.value.ok) { const data = await centrumResp.value.json(); results.push(data.summary || "Centrum ✅"); } else results.push("Centrum ❌");
      if (dashboardResp.status === "fulfilled" && dashboardResp.value.ok) results.push("Dashboard ✅");
      toast.success(results.join(" | "));
      setRefreshTrigger(p => p + 1);
    } catch { toast.error("Synchronizace Centra selhala"); }
    finally { setIsCentrumSyncing(false); }
  }, []);

  const runCleanupTasks = useCallback(async () => {
    setIsCleaningTasks(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase.from("did_therapist_tasks").update({ status: "archived" } as any).in("status", ["not_started", "pending"] as any).lt("created_at", sevenDaysAgo).select("id");
      if (error) throw error;
      toast.success(`Archivováno ${data?.length || 0} starých úkolů`);
      setRefreshTrigger(p => p + 1);
    } catch { toast.error("Čištění úkolů selhalo"); }
    finally { setIsCleaningTasks(false); }
  }, []);

  const warningParts = useMemo(() => parts.filter(p => p.status === "warning"), [parts]);

  if (loading) {
    return (
      <div className="max-w-[900px] mx-auto px-4 py-6 space-y-6" style={{ backgroundColor: "#F5F3EF", minHeight: "100vh" }}>
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-40 w-full" />
        <SkeletonBlock className="h-32 w-full" />
        <SkeletonBlock className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#F5F3EF" }} data-no-swipe-back="true">
      <div className="max-w-[900px] mx-auto px-4 py-6 space-y-6">

        {/* ═══ REFRESH BAR ═══ */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[12px]" style={{ color: "#4A4A4A" }}>
              Aktualizováno: {lastRefreshAt.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <div className="flex items-center gap-1">
              <div className={cn("w-1.5 h-1.5 rounded-full", realtimeConnected ? "bg-green-500" : "bg-gray-400")} />
              <span className="text-[11px]" style={{ color: "#4A4A4A" }}>{realtimeConnected ? "live" : "offline"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 px-3 text-[12px] gap-1" onClick={() => setRefreshTrigger(p => p + 1)}>
              <RefreshCw className="w-3 h-3" /> Obnovit
            </Button>
            <DidSprava
              onBootstrap={runDidBootstrap} isBootstrapping={isBootstrapping}
              onHealthAudit={runHealthAudit} isAuditing={isAuditing}
              onReformat={runReformat} isReformatting={isReformatting}
              onManualUpdate={onManualUpdate} isUpdating={isUpdating}
              onCentrumSync={runCentrumSync} isCentrumSyncing={isCentrumSyncing}
              onCleanupTasks={runCleanupTasks} isCleaningTasks={isCleaningTasks}
              onRefreshMemory={onRefreshMemory} isRefreshingMemory={isRefreshingMemory}
              refreshTrigger={refreshTrigger}
              onSelectPart={onQuickThread ? (partName) => onQuickThread("", partName) : undefined}
            />
          </div>
        </div>

        {/* ═══ SYSTEM HEALTH BANNER ═══ */}
        {healthIssues.length > 0 && (
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-4 border-l-4" style={{ borderLeftColor: "#DC2626" }}>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4" style={{ color: "#DC2626" }} />
              <span className="text-[14px] font-semibold" style={{ color: "#DC2626" }}>Systémový problém</span>
            </div>
            {healthIssues.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between gap-2 py-1">
                <span className="text-[14px]" style={{ color: "#4A4A4A" }}>• {h.message}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[12px] h-6 px-2"
                  onClick={async () => {
                    await supabase.from("system_health_log").update({ resolved: true }).eq("id", h.id);
                    setHealthIssues(prev => prev.filter(x => x.id !== h.id));
                    toast.success("Vyřešeno");
                  }}
                >
                  Vyřešeno
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* ═══ 2. CRISIS DETAIL (collapsible) — from shared hook ═══ */}
        {crisisCards.length > 0 && (
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-4">
            <button
              onClick={() => setShowCrisisDetail(!showCrisisDetail)}
              className="w-full flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4" style={{ color: "#7C2D2D" }} />
                <span className="text-[14px] font-semibold" style={{ color: "#7C2D2D" }}>
                  Aktivní krize ({crisisCards.length})
                </span>
              </div>
              <span className="text-[12px]" style={{ color: "#4A4A4A" }}>
                {showCrisisDetail ? "Sbalit ▲" : "Rozbalit ▼"}
              </span>
            </button>

            {showCrisisDetail && (
              <div className="mt-3 space-y-3">
                {crisisCards.map((card) => (
                  <div key={card.eventId || card.alertId || card.partName} className="rounded-lg p-3 space-y-2" style={{ backgroundColor: "#7C2D2D10", border: "1px solid #7C2D2D30" }}>
                    <div className="flex items-center justify-between">
                      <span className="text-[14px] font-semibold" style={{ color: "#7C2D2D" }}>
                        {card.displayName} ({card.severity})
                      </span>
                      <span className="text-[12px]" style={{ color: "#4A4A4A" }}>
                        {card.displaySummary}
                      </span>
                    </div>

                    {/* Karel requires */}
                    {card.karelRequires.length > 0 && (
                      <div className="text-[12px] text-blue-700 dark:text-blue-400">
                        <span className="font-semibold">Karel vyžaduje:</span>{" "}
                        {card.karelRequires.slice(0, 2).join(" · ")}
                        {card.karelRequires.length > 2 && ` (+${card.karelRequires.length - 2})`}
                      </div>
                    )}

                     <div className="flex gap-2 flex-wrap items-center">
                       <button
                         onClick={() => navigate(card.meetingId ? `/chat?meeting=${card.meetingId}` : card.conversationId ? `/chat?meeting=${card.conversationId}` : `/chat?sub=meeting`)}
                         className="text-[11px] px-2.5 py-1 rounded-md font-medium border transition-colors"
                         style={{ color: "#7C2D2D", borderColor: "#7C2D2D40", backgroundColor: "transparent" }}
                         onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#7C2D2D10"; }}
                         onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                       >
                         Krizová porada
                       </button>
                       <span className="text-[10px] text-muted-foreground">
                         {card.meetingOpen
                           ? (card.meetingStatusSummary || "otevřená")
                           : card.crisisMeetingRequired
                             ? "doporučená"
                             : card.meetingLastConclusionAt
                               ? "uzavřená"
                               : "není potřeba"}
                       </span>
                     </div>
                    {/* No closure controls here — dashboard is secondary overview only */}

                    {card.alertId && (
                      <details className="text-[12px]">
                        <summary className="cursor-pointer" style={{ color: "#4A4A4A" }}>Zobrazit historii</summary>
                        <div className="mt-2">
                          <CrisisTimeline
                            crisisAlertId={card.alertId}
                            partName={card.partName}
                          />
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ 3. HLAVNÍ BRIEFING — Operativní plán z 05A ═══ */}
        <ErrorBoundary fallbackTitle="Denní plán selhal">
          <KarelDailyPlan refreshTrigger={refreshTrigger} />
        </ErrorBoundary>

        {/* ═══ 4. ÚKOLY TÝMU ═══ */}
        <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[18px] font-semibold flex items-center gap-2" style={{ color: "#2D2D2D" }}>
              📋 Úkoly
            </h3>
            {pendingWriteCount > 0 && (
              <span className="text-[12px] px-2 py-0.5 rounded-full" style={{ backgroundColor: "#F59E0B20", color: "#B45309" }}>
                <Upload className="w-3 h-3 inline mr-1" />{pendingWriteCount} čeká na Drive
              </span>
            )}
          </div>
          <ErrorBoundary fallbackTitle="Task board selhal">
            <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
          </ErrorBoundary>
        </div>

        {/* ═══ 5. KDO MLUVÍ S KARLEM ═══ */}
        {activeThreads.length > 0 && (
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-4">
            <h3 className="text-[18px] font-semibold mb-3" style={{ color: "#2D2D2D" }}>Kdo mluví s Karlem</h3>
            <div className="flex flex-wrap gap-2">
              {activeThreads.map(t => {
                if (isNonDidEntity(t.partName)) return null;
                return (
                  <button
                    key={t.id}
                    onClick={() => onQuickThread?.(t.id, t.partName)}
                    className="text-[14px] px-3 py-1.5 rounded-lg border transition-colors hover:bg-gray-50"
                    style={{ color: "#01696F", borderColor: "#01696F40" }}
                  >
                    {cleanDisplayName(t.partName)}
                    <span className="text-[12px] ml-1 opacity-60">({t.messageCount})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ 6. PLÁN SEZENÍ ═══ */}
        <ErrorBoundary fallbackTitle="Denní plán selhal">
          <DidDailySessionPlan refreshTrigger={refreshTrigger} />
        </ErrorBoundary>

        {/* ═══ 8. DOHODY & TÝDENNÍ ANALÝZA ═══ */}
        <ErrorBoundary fallbackTitle="Dohody selhaly">
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5">
            <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger(p => p + 1)} />
          </div>
        </ErrorBoundary>

        {/* ═══ 9. MĚSÍČNÍ PŘEHLEDY ═══ */}
        <ErrorBoundary fallbackTitle="Měsíční panel selhal">
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5">
            <DidMonthlyPanel refreshTrigger={refreshTrigger} />
          </div>
        </ErrorBoundary>

        {/* ═══ 10. MAPA SYSTÉMU (active only) ═══ */}
        {parts.filter(p => p.status === "active").length > 0 && (
          <ErrorBoundary fallbackTitle="Mapa systému selhala">
            <DidSystemMap
              parts={parts.filter(p => p.status === "active")}
              activeThreads={activeThreads}
              onQuickThread={onQuickThread}
              onDeletePart={async (partName) => {
                const { error } = await supabase.from("did_threads").delete().eq("part_name", partName).eq("sub_mode", "cast");
                if (error) { toast.error(`Nepodařilo se smazat vlákna pro ${partName}`); return; }
                toast.success(`Vlákna pro „${partName}" smazána z mapy`);
                setParts(prev => prev.filter(p => p.name !== partName));
                setActiveThreads(prev => prev.filter(t => t.partName !== partName));
              }}
            />
          </ErrorBoundary>
        )}

        {/* ═══ 11. SUPERVIZNÍ REPORT ═══ */}
        <ErrorBoundary fallbackTitle="Supervizní report selhal">
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5">
            <DidSupervisionReport refreshTrigger={refreshTrigger} />
          </div>
        </ErrorBoundary>

        {/* Warning parts */}
        {warningParts.length > 0 && (
          <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4" style={{ color: "#B45309" }} />
              <span className="text-[14px] font-semibold" style={{ color: "#2D2D2D" }}>Neaktivní části</span>
            </div>
            <p className="text-[14px]" style={{ color: "#4A4A4A" }}>{warningParts.map(p => cleanDisplayName(p.name)).join(", ")} – neaktivní více než 7 dní.</p>
          </div>
        )}

        {/* Footer status */}
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl text-[12px]" style={{ color: "#4A4A4A", backgroundColor: "#F0EFEB" }}>
          <span>Části: <strong>{parts.filter(p => p.status === "active").length}</strong> aktivních</span>
          <span>•</span>
          <span>Vlákna: <strong>{activeThreads.length}</strong></span>
        </div>
      </div>
    </div>
  );
};

export default DidDashboard;
