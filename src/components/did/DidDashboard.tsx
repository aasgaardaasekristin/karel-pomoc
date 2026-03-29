import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, ListChecks, Upload, RefreshCw, Shield, MessageSquare, Heart, Target, ShieldCheck, ArrowUpRight, ArrowDownRight, ArrowRight } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelBadge } from "@/components/ui/KarelBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isNonDidEntity } from "@/lib/didPartNaming";
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
import PartQuickView from "./PartQuickView";
import CrisisTimeline from "./CrisisTimeline";
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

interface DashboardMetrics {
  todayMsgCount: number;
  todayConversations: number;
  todayValence: number | null;
  activeGoals: number;
  avgGoalProgress: number;
  newAlerts: number;
  criticalAlerts: number;
  highAlerts: number;
}

interface PartHeatmapRow {
  partName: string;
  role: string | null;
  valence: number | null;
  trendArrow: "↗" | "↘" | "→" | null;
  msgCount: number;
  goalCount: number;
  alertCount: number;
  switchCount: number;
}

interface GoalRow {
  id: string;
  partName: string | null;
  goalText: string;
  progressPct: number;
  status: string;
}

interface SwitchEvent {
  id: string;
  originalPart: string;
  detectedPart: string;
  confidence: string;
  createdAt: string;
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
  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-3 mb-2.5 pb-1 relative after:absolute after:bottom-0 after:left-0 after:w-8 after:h-px after:bg-primary/30">
    {children}
  </h3>
);

// ── Skeleton placeholder ──
const SkeletonBlock = ({ className }: { className?: string }) => (
  <div className={cn("animate-pulse rounded-md bg-muted", className)} />
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
  const [activeCrises, setActiveCrises] = useState<any[]>([]);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date>(new Date());

  // New dashboard data
  const [metrics, setMetrics] = useState<DashboardMetrics>({ todayMsgCount: 0, todayConversations: 0, todayValence: null, activeGoals: 0, avgGoalProgress: 0, newAlerts: 0, criticalAlerts: 0, highAlerts: 0 });
  const [heatmapRows, setHeatmapRows] = useState<PartHeatmapRow[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [proposedGoals, setProposedGoals] = useState(0);
  const [unreadNotes, setUnreadNotes] = useState(0);
  const [weekActivity, setWeekActivity] = useState<[string, number][]>([]);
  const [todaySwitches, setTodaySwitches] = useState<SwitchEvent[]>([]);
  const [lastReportStatus, setLastReportStatus] = useState<string | null>(null);
  const [todayAiErrors, setTodayAiErrors] = useState(0);
  const [activePartsCount, setActivePartsCount] = useState(0);
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  const [assessingCrisisId, setAssessingCrisisId] = useState<string | null>(null);
  const loadDashboardData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const today = todayISO();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const todayStart = today + "T00:00:00";

      const results = await Promise.all([
        supabase.from("did_threads").select("id, part_name, last_activity_at, messages, sub_mode").in("sub_mode", ["cast", "crisis"]).order("last_activity_at", { ascending: false }),
        supabase.from("did_pending_drive_writes").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("crisis_alerts").select("*").in("status", ["ACTIVE", "ACKNOWLEDGED"]).order("created_at", { ascending: false }),
        supabase.from("did_part_registry").select("part_name, display_name, status, role_in_system, last_seen_at, known_strengths, known_triggers").eq("status", "active"),
        supabase.from("daily_metrics").select("part_name, message_count, emotional_valence, switching_count, risk_signals_count").eq("metric_date", today),
        supabase.from("daily_metrics").select("part_name, metric_date, message_count, emotional_valence").gte("metric_date", weekAgo).order("metric_date", { ascending: true }),
        supabase.from("strategic_goals").select("id, part_name, goal_text, progress_pct, status").eq("status", "active"),
        supabase.from("strategic_goals").select("id", { count: "exact", head: true }).eq("status", "proposed"),
        (supabase as any).from("safety_alerts").select("id, severity, part_name, status").in("status", ["new", "notified"]),
        supabase.from("switching_events").select("id, original_part, detected_part, confidence, created_at").gte("created_at", todayStart).order("created_at", { ascending: false }),
        (supabase as any).from("therapist_notes").select("id", { count: "exact", head: true }).eq("is_read_by_karel", false),
        supabase.from("did_threads").select("id, part_name", { count: "exact" }).in("sub_mode", ["cast", "crisis"]).gte("last_activity_at", todayStart),
        supabase.from("did_daily_report_dispatches").select("status").order("created_at", { ascending: false }).limit(1),
        supabase.from("ai_error_log").select("id", { count: "exact", head: true }).gte("created_at", todayStart),
      ]);
      const [threadsRes, pendingWritesRes, crisisRes, registryRes, todayMetricsRes, weekMetricsRes, activeGoalsRes, proposedGoalsRes, safetyRes, switchesRes, unreadNotesRes, todayThreadsRes, lastDispatchRes, aiErrorsRes] = results as any;

      setActiveCrises(crisisRes.data || []);

      // ── Process threads (original logic) ──
      const threads = threadsRes.data || [];
      const latestByPart = new Map<string, ActiveThreadSummary>();
      const partRows: PartActivity[] = [];
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

      // ── Registry + active parts (filter out non-DID entities) ──
      const registry = (registryRes.data || []).filter((r: any) => !isNonDidEntity(r.part_name));
      setActivePartsCount(registry.length);

      // ── Today metrics aggregation ──
      const todayM = todayMetricsRes.data || [];
      const totalMsgs = todayM.reduce((s, m) => s + (m.message_count || 0), 0);
      const valences = todayM.filter(m => m.emotional_valence != null).map(m => m.emotional_valence!);
      const avgValence = valences.length > 0 ? valences.reduce((a, b) => a + b, 0) / valences.length : null;

      // ── Goals ──
      const goalsData = (activeGoalsRes.data || []).map(g => ({ id: g.id, partName: g.part_name, goalText: g.goal_text, progressPct: g.progress_pct || 0, status: g.status || "active" }));
      setGoals(goalsData);
      const avgProgress = goalsData.length > 0 ? Math.round(goalsData.reduce((s, g) => s + g.progressPct, 0) / goalsData.length) : 0;
      setProposedGoals(proposedGoalsRes.count || 0);

      // ── Safety alerts ──
      const alerts = safetyRes.data || [];
      const critCount = alerts.filter((a: any) => a.severity === "critical").length;
      const highCount = alerts.filter((a: any) => a.severity === "high").length;

      setMetrics({
        todayMsgCount: totalMsgs,
        todayConversations: todayThreadsRes.count || 0,
        todayValence: avgValence,
        activeGoals: goalsData.length,
        avgGoalProgress: avgProgress,
        newAlerts: alerts.length,
        criticalAlerts: critCount,
        highAlerts: highCount,
      });

      // ── Unread notes ──
      setUnreadNotes(unreadNotesRes.count || 0);

      // ── Heatmap ──
      const weekM = weekMetricsRes.data || [];
      const todayMetricsByPart = new Map(todayM.map(m => [m.part_name?.toUpperCase(), m]));
      const goalsByPart = new Map<string, number>();
      for (const g of goalsData) {
        const k = (g.partName || "").toUpperCase();
        goalsByPart.set(k, (goalsByPart.get(k) || 0) + 1);
      }
      const alertsByPart = new Map<string, number>();
      for (const a of alerts) {
        const k = ((a as any).part_name || "").toUpperCase();
        alertsByPart.set(k, (alertsByPart.get(k) || 0) + 1);
      }
      const switchesByPart = new Map<string, number>();
      for (const s of (switchesRes.data || [])) {
        const k = (s.detected_part || "").toUpperCase();
        switchesByPart.set(k, (switchesByPart.get(k) || 0) + 1);
      }

      const heatmap: PartHeatmapRow[] = registry.map(r => {
        const key = r.part_name.toUpperCase();
        const tm = todayMetricsByPart.get(key);
        const partWeek = weekM.filter(w => (w.part_name || "").toUpperCase() === key);
        let trendArrow: PartHeatmapRow["trendArrow"] = null;
        if (partWeek.length >= 2) {
          const first = partWeek[0].emotional_valence ?? 5;
          const last = partWeek[partWeek.length - 1].emotional_valence ?? 5;
          const diff = last - first;
          trendArrow = diff > 0.5 ? "↗" : diff < -0.5 ? "↘" : "→";
        }
        return {
          partName: r.part_name,
          role: r.role_in_system || null,
          valence: (tm as any)?.emotional_valence ?? null,
          trendArrow,
          msgCount: (tm as any)?.message_count || 0,
          goalCount: goalsByPart.get(key) || 0,
          alertCount: alertsByPart.get(key) || 0,
          switchCount: switchesByPart.get(key) || 0,
        };
      });
      setHeatmapRows(heatmap);

      // ── Week activity chart ──
      const dayMap = new Map<string, number>();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        dayMap.set(d, 0);
      }
      for (const m of weekM) {
        const existing = dayMap.get(m.metric_date) ?? 0;
        dayMap.set(m.metric_date, existing + (m.message_count || 0));
      }
      setWeekActivity(Array.from(dayMap.entries()));

      // ── Today switches ──
      setTodaySwitches((switchesRes.data || []).map(s => ({
        id: s.id,
        originalPart: s.original_part,
        detectedPart: s.detected_part,
        confidence: s.confidence,
        createdAt: s.created_at,
      })));

      // ── System footer ──
      setLastReportStatus(lastDispatchRes.data?.[0]?.status || null);
      setTodayAiErrors(aiErrorsRes.count || 0);

      setLastRefreshAt(new Date());
    } catch (error) {
      console.error("Failed to load DID dashboard data:", error);
      toast.error("Nepodařilo se načíst DID dashboard");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Auto-refresh every 60s
  useEffect(() => { loadDashboardData(); }, [loadDashboardData, refreshTrigger]);
  useEffect(() => {
    const interval = setInterval(() => { loadDashboardData(true); }, 60000);
    return () => clearInterval(interval);
  }, [loadDashboardData]);

  // ── Realtime subscriptions ──
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  useEffect(() => {
    const alertChannel = supabase
      .channel("dashboard-safety-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "safety_alerts" }, (payload: any) => {
        const severity = payload.new?.severity;
        const partName = payload.new?.part_name;
        if (severity === "critical") {
          playAlertSound();
          toast.error(`🚨 KRITICKÝ ALERT: ${payload.new?.alert_type} — ${partName || "neznámá část"}`, { duration: 15000 });
        } else if (severity === "high") {
          toast.warning(`⚠️ Vysoký alert: ${payload.new?.alert_type} — ${partName || "?"}`, { duration: 10000 });
        }
        loadDashboardData(true);
      })
      .subscribe();

    const switchChannel = supabase
      .channel("dashboard-switching")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "switching_events" }, (payload: any) => {
        const from = payload.new?.original_part;
        const to = payload.new?.detected_part;
        const confidence = payload.new?.confidence;
        if (confidence === "high" || confidence === "confirmed") {
          toast.info(`🔄 Switching: ${from} → ${to}`, { duration: 5000 });
        }
        loadDashboardData(true);
      })
      .subscribe();

    const crisisChannel = supabase
      .channel("dashboard-crisis")
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_alerts" }, (payload: any) => {
        if (payload.eventType === "INSERT") {
          playAlertSound();
          toast.error(`🔴 NOVÁ KRIZE: ${payload.new?.part_name || "?"} — ${payload.new?.severity || "?"}`, { duration: 20000 });
        }
        loadDashboardData(true);
      })
      .subscribe();

    const notesChannel = supabase
      .channel("dashboard-notes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "therapist_notes" }, () => {
        loadDashboardData(true);
      })
      .subscribe();

    setRealtimeConnected(true);

    return () => {
      setRealtimeConnected(false);
      supabase.removeChannel(alertChannel);
      supabase.removeChannel(switchChannel);
      supabase.removeChannel(crisisChannel);
      supabase.removeChannel(notesChannel);
    };
  }, [loadDashboardData]);

  // ── Action callbacks (kept from original) ──
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
  const maxWeekMsgs = useMemo(() => Math.max(1, ...weekActivity.map(([, c]) => c)), [weekActivity]);

  const runCrisisAssessment = useCallback(async (crisisId: string) => {
    setAssessingCrisisId(crisisId);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-crisis-daily-assessment`, {
        method: "POST", headers, body: JSON.stringify({ crisis_alert_id: crisisId, manual: true }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      const result = data.results?.[0];
      if (result) {
        toast.success(`Hodnocení den ${result.day_number}: ${result.decision} | Risk: ${result.risk_level} | ${result.tasks_created} úkolů`);
      }
      setRefreshTrigger(p => p + 1);
    } catch (e: any) {
      toast.error(`Krizové hodnocení selhalo: ${e.message}`);
    } finally {
      setAssessingCrisisId(null);
    }
  }, []);

  const valenceEmoji = (v: number | null) => v == null ? "⚪" : v >= 7 ? "😊" : v >= 4 ? "😐" : "😟";

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6 space-y-3">
        <SkeletonBlock className="h-8 w-full" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[1,2,3,4].map(i => <SkeletonBlock key={i} className="h-16" />)}
        </div>
        <SkeletonBlock className="h-32" />
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-16" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 space-y-3" data-no-swipe-back="true">

      {/* ═══ SEKCE 1: REFRESH BAR ═══ */}
      <div className="flex items-center justify-between pb-2 border-b border-border/30">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            Aktualizováno: {lastRefreshAt.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}
          </span>
          <div className="flex items-center gap-1">
            <div className={cn("w-1.5 h-1.5 rounded-full", realtimeConnected ? "bg-green-500 animate-pulse" : "bg-muted-foreground")} />
            <span className="text-[9px] text-muted-foreground">{realtimeConnected ? "live" : "offline"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] gap-1" onClick={() => { setRefreshTrigger(p => p + 1); }}>
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

      {/* ═══ SEKCE 2: URGENTNÍ BANNERY ═══ */}
      {/* Crisis alerts */}
      {activeCrises.length > 0 && (
        <div className="rounded-xl border-2 border-destructive bg-destructive/10 backdrop-blur-sm shadow-sm p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-destructive" />
            <span className="text-xs font-bold text-destructive">🔴 AKTIVNÍ KRIZE – {activeCrises.length}</span>
          </div>
          {activeCrises.map((c: any) => (
            <div key={c.id} className="rounded-lg bg-destructive/5 border border-destructive/30 p-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-destructive">{c.part_name} ({c.severity})</span>
                <span className="text-[10px] text-muted-foreground">{c.status}{c.days_in_crisis ? ` · den ${c.days_in_crisis}` : ""}</span>
              </div>
              <p className="text-[10px] text-foreground">{c.summary}</p>
              <button onClick={() => navigate(c.conversation_id ? `/chat?meeting=${c.conversation_id}` : `/chat?sub=meeting`)} className="text-[10px] bg-destructive text-destructive-foreground px-2 py-1 rounded font-semibold">Otevřít krizovou poradu</button>
              <CrisisTimeline
                crisisAlertId={c.id}
                partName={c.part_name}
                onRunAssessment={() => runCrisisAssessment(c.id)}
                isAssessing={assessingCrisisId === c.id}
              />
            </div>
          ))}
        </div>
      )}

      {/* Safety alerts banner */}
      {metrics.newAlerts > 0 && (
        <div className={cn("rounded-xl border p-2 flex items-center gap-2 text-xs backdrop-blur-sm shadow-sm",
          metrics.criticalAlerts > 0 ? "border-destructive bg-destructive/10 text-destructive" : "border-amber-500 bg-amber-500/10 text-amber-700"
        )}>
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-medium">
            {metrics.criticalAlerts > 0 ? `🚨 ${metrics.criticalAlerts} kritických` : ""}{metrics.criticalAlerts > 0 && metrics.highAlerts > 0 ? ", " : ""}{metrics.highAlerts > 0 ? `⚠️ ${metrics.highAlerts} vysokých` : ""} bezpečnostních alertů
          </span>
        </div>
      )}

      {/* Proposed goals banner */}
      {proposedGoals > 0 && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 backdrop-blur-sm shadow-sm p-2 flex items-center gap-2 text-xs text-primary">
          <Target className="w-4 h-4 shrink-0" />
          <span className="font-medium">🎯 {proposedGoals} navrhovaných cílů čeká na schválení</span>
        </div>
      )}

      {/* Unread therapist notes */}
      {unreadNotes > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-50 dark:bg-amber-950/20 backdrop-blur-sm shadow-sm p-2 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
          <MessageSquare className="w-4 h-4 shrink-0" />
          <span className="font-medium">📝 {unreadNotes} nepřečtených poznámek terapeutek</span>
        </div>
      )}

      {/* ═══ SEKCE 3: SOUHRNNÉ KARTY ═══ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCard icon={<MessageSquare className="w-3.5 h-3.5 text-primary" />} label="Zprávy dnes" value={`${metrics.todayMsgCount}`} sub={`${metrics.todayConversations} konverzací`} />
        <SummaryCard icon={<Heart className="w-3.5 h-3.5 text-primary" />} label="Emoční valence" value={valenceEmoji(metrics.todayValence)} sub={metrics.todayValence != null ? `${metrics.todayValence.toFixed(1)} / 10` : "žádná data"} />
        <SummaryCard icon={<Target className="w-3.5 h-3.5 text-primary" />} label="Aktivní cíle" value={`${metrics.activeGoals}`} sub={`ø progress ${metrics.avgGoalProgress}%`} />
        <SummaryCard icon={<ShieldCheck className="w-3.5 h-3.5 text-primary" />} label="Bezpečnost" value={metrics.newAlerts > 0 ? `${metrics.newAlerts} ⚠️` : "✅ OK"} sub={metrics.newAlerts > 0 ? "vyžaduje pozornost" : "vše v pořádku"} />
      </div>

      {/* ═══ SEKCE 4: HEATMAPA ČÁSTÍ ═══ */}
      {heatmapRows.length > 0 && (
        <div>
          <SectionLabel>Části systému</SectionLabel>
          <div className="space-y-1">
            {heatmapRows.map(row => (
              <div key={row.partName} className={cn("rounded-lg border border-border/40 overflow-hidden cursor-pointer bg-card/30 backdrop-blur-sm transition-colors", expandedPart === row.partName && "border-primary/40")} onClick={() => setExpandedPart(expandedPart === row.partName ? null : row.partName)}>
                <div className="flex items-center gap-2 p-2 text-xs hover:bg-primary/5 transition-colors">
                  <span className="text-base w-6 text-center">👤</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-semibold truncate">{row.partName}</span>
                    {row.role && <span className="text-[10px] italic text-muted-foreground ml-1">({row.role})</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-3 h-3 rounded-full", row.valence == null ? "bg-muted" : row.valence >= 7 ? "bg-green-400" : row.valence >= 4 ? "bg-amber-400" : "bg-red-400")} />
                    {row.trendArrow && (
                      <span className={cn("text-xs font-bold", row.trendArrow === "↗" && "text-green-600", row.trendArrow === "↘" && "text-red-600", row.trendArrow === "→" && "text-muted-foreground")}>{row.trendArrow}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">{row.msgCount}💬</span>
                    {row.goalCount > 0 && <span className="text-[10px]">🎯{row.goalCount}</span>}
                    {row.alertCount > 0 && <Badge variant="destructive" className="text-[8px] h-3.5 px-1">⚠️{row.alertCount}</Badge>}
                    {row.switchCount > 0 && <span className="text-[10px] text-amber-500">🔄{row.switchCount}</span>}
                  </div>
                </div>
                {expandedPart === row.partName && (
                  <PartQuickView partName={row.partName} onClose={() => setExpandedPart(null)} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ SEKCE 5: PROGRESS AKTIVNÍCH CÍLŮ ═══ */}
      {goals.length > 0 && (
        <div>
          <SectionLabel>Aktivní cíle</SectionLabel>
          <div className="space-y-1.5">
            {goals.slice(0, 5).map(g => (
              <div key={g.id} className="p-2 rounded-lg border border-border/30 bg-card/20 backdrop-blur-sm text-xs space-y-1">
                <div className="flex items-center gap-1.5">
                  {g.partName && <Badge variant="secondary" className="text-[9px] h-4 px-1">{g.partName}</Badge>}
                  <span className="truncate flex-1">{g.goalText}</span>
                  <span className="text-[10px] text-muted-foreground font-medium">{g.progressPct}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                  <div className={cn("h-full rounded-full transition-all duration-500", g.progressPct >= 75 ? "bg-green-500" : g.progressPct >= 40 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, g.progressPct)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ SEKCE 6: TÝDENNÍ AKTIVITA ═══ */}
      {weekActivity.length > 0 && (
        <div>
          <SectionLabel>Týdenní aktivita</SectionLabel>
          <div className="flex items-end gap-1 h-16 p-2 rounded-md border bg-card/20 backdrop-blur-sm">
            {weekActivity.map(([date, count]) => (
              <div key={date} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end">
                {count > 0 && <span className="text-[8px] text-muted-foreground">{count}</span>}
                <div className="w-full bg-gradient-to-t from-primary/80 to-primary/40 rounded-sm min-h-[2px]" style={{ height: `${(count / maxWeekMsgs) * 100}%` }} />
                <span className="text-[8px] text-muted-foreground">{new Date(date + "T12:00:00").toLocaleDateString("cs", { weekday: "narrow" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ EXISTING SECTIONS ═══ */}
      <ErrorBoundary fallbackTitle="Přehled systému selhal">
        <KarelCard variant="default" padding="md" className="border-l-4 border-l-[hsl(var(--accent-primary))]">
          <DidSystemOverview refreshTrigger={refreshTrigger} onTasksSynced={() => setRefreshTrigger(p => p + 1)} />
        </KarelCard>
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Denní plán selhal">
        <DidDailySessionPlan refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      <section>
        <SectionLabel>Úkoly pro terapeutky</SectionLabel>
        <KarelCard variant="default" padding="md">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ListChecks size={14} className="text-[hsl(var(--accent-primary))]" />
              <span className="text-sm font-medium text-foreground">Task Board</span>
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

      <ErrorBoundary fallbackTitle="Dohody selhaly">
        <KarelCard variant="default" padding="md">
          <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger(p => p + 1)} />
        </KarelCard>
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Měsíční panel selhal">
        <KarelCard variant="default" padding="md">
          <DidMonthlyPanel refreshTrigger={refreshTrigger} />
        </KarelCard>
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Pulse check selhal">
        <DidPulseCheck refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Koordinační upozornění selhala">
        <DidCoordinationAlerts refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Supervizní report selhal">
        <DidSupervisionReport refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {/* ═══ SEKCE 7: DNEŠNÍ SWITCHING ═══ */}
      {todaySwitches.length > 0 && (
        <div>
          <SectionLabel>Dnešní switching</SectionLabel>
          <div className="space-y-1">
            {todaySwitches.map(s => (
              <div key={s.id} className="flex items-center gap-2 p-2 rounded-md border text-xs bg-card/20 hover:bg-card/40 transition-colors">
                <span className="text-[10px] text-muted-foreground">{new Date(s.createdAt).toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="font-medium">{s.originalPart}</span>
                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                <span className="font-medium">{s.detectedPart}</span>
                <Badge variant={s.confidence === "high" ? "destructive" : "secondary"} className="text-[8px] h-4 px-1 ml-auto">{s.confidence}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <ErrorBoundary fallbackTitle="Switch historie selhala">
        <DidSwitchHistory refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      <ErrorBoundary fallbackTitle="Pohled kolegyně selhal">
        <DidColleagueView refreshTrigger={refreshTrigger} />
      </ErrorBoundary>

      {!loading && parts.length > 0 && (
        <ErrorBoundary fallbackTitle="Mapa systému selhala">
          <DidSystemMap parts={parts} activeThreads={activeThreads} onQuickThread={onQuickThread}
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

      {warningParts.length > 0 && (
        <KarelCard variant="outlined" padding="md">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={16} className="text-primary" />
            <span className="text-sm font-medium">Upozornění na neaktivní části</span>
          </div>
          <p className="text-xs text-muted-foreground">{warningParts.map(p => p.name).join(", ")} – neaktivní více než 7 dní.</p>
        </KarelCard>
      )}

      {/* ═══ SEKCE 8: SYSTÉMOVÝ STAV FOOTER ═══ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-xl bg-card/30 backdrop-blur-sm border border-border/30 text-[10px] text-muted-foreground">
        <span>Report: <strong className={lastReportStatus === "sent" ? "text-green-600" : lastReportStatus === "failed" ? "text-destructive" : "text-foreground"}>{lastReportStatus || "—"}</strong></span>
        <span>AI chyby dnes: <strong className={todayAiErrors > 0 ? "text-amber-600" : "text-foreground"}>{todayAiErrors}</strong></span>
        <span>Aktivní části: <strong className="text-foreground">{activePartsCount}</strong></span>
      </div>
    </div>
  );
};

// ── Summary card component ──
function SummaryCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm shadow-sm p-2.5 space-y-1">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <p className="text-base font-bold text-foreground leading-none">{value}</p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

export default DidDashboard;
