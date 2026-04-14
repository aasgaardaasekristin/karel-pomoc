import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useCrisisOperationalState, type CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, Upload, RefreshCw, Shield, Zap, MessageSquare, Clock, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isNonDidEntity, cleanDisplayName } from "@/lib/didPartNaming";
import type { DidSubMode } from "./DidSubModeSelector";
import KarelDailyPlan from "./KarelDailyPlan";
import DidDailySessionPlan from "./DidDailySessionPlan";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidCoordinationAlerts from "./DidCoordinationAlerts";
import DidSprava from "./DidSprava";
import DidSupervisionReport from "./DidSupervisionReport";
import DidSystemMap from "./DidSystemMap";
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

const STATE_LABELS: Record<string, string> = {
  active: "aktivní",
  intervened: "po zásahu",
  stabilizing: "stabilizace",
  awaiting_session_result: "čeká výsledek",
  awaiting_therapist_feedback: "čeká feedback",
  ready_for_joint_review: "k poradě",
  ready_to_close: "k uzavření",
  closed: "uzavřeno",
  monitoring_post: "monitoring",
};

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

// ── Section card wrapper ──
const StudyCard = ({ children, className, accent }: { children: React.ReactNode; className?: string; accent?: "crisis" | "gold" | "warning" }) => {
  const borderLeft = accent === "crisis"
    ? "border-l-[3px] border-l-[hsl(8,55%,48%)]"
    : accent === "gold"
    ? "border-l-[3px] border-l-[hsl(38,42%,48%)]"
    : accent === "warning"
    ? "border-l-[3px] border-l-[hsl(38,60%,55%)]"
    : "";

  return (
    <div className={cn("jung-card p-5", borderLeft, className)}>
      {children}
    </div>
  );
};

const SectionTitle = ({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) => (
  <h3 className="jung-section-title text-[17px] flex items-center gap-2.5 mb-4">
    {icon}
    {children}
  </h3>
);

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

  // ── Aggregate "Karel vyžaduje" from ALL operational sources ──
  const [karelPendingQuestions, setKarelPendingQuestions] = useState<{ question: string; directed_to: string }[]>([]);
  const [karelMissingSessions, setKarelMissingSessions] = useState<{ part: string; type: string }[]>([]);
  const [karelCommitments, setKarelCommitments] = useState<{ text: string; due: string; by: string }[]>([]);

  useEffect(() => {
    const loadKarelRequires = async () => {
      const today = todayISO();
      const [qRes, commitRes] = await Promise.all([
        (supabase as any).from("did_pending_questions").select("question, directed_to").in("status", ["pending", "sent"]).order("created_at", { ascending: false }).limit(5),
        (supabase as any).from("karel_commitments").select("commitment_text, due_date, committed_by").eq("status", "open").lte("due_date", today).order("due_date", { ascending: true }).limit(5),
      ]);
      setKarelPendingQuestions(qRes.data || []);
      setKarelCommitments((commitRes.data || []).map((c: any) => ({ text: c.commitment_text, due: c.due_date, by: c.committed_by })));

      // Missing session results: crisis parts with sessions awaiting write-up
      const missing: { part: string; type: string }[] = [];
      for (const card of crisisCards) {
        if (card.missingSessionResult) missing.push({ part: card.displayName, type: "výsledek sezení" });
        if (card.missingTherapistFeedback) missing.push({ part: card.displayName, type: "feedback terapeutky" });
        if (card.missingTodayInterview) missing.push({ part: card.displayName, type: "dnešní interview" });
      }
      setKarelMissingSessions(missing);
    };
    loadKarelRequires();
  }, [crisisCards, refreshTrigger]);

  const karelRequirements = useMemo(() => {
    const reqs: { text: string; source: string; severity: string; category: string }[] = [];
    // 1. Crisis card explicit requirements
    for (const card of crisisCards) {
      for (const req of card.karelRequires) {
        reqs.push({ text: req, source: card.displayName, severity: card.severity || "medium", category: "krize" });
      }
    }
    // 2. Missing outputs
    for (const m of karelMissingSessions) {
      reqs.push({ text: `Chybí ${m.type}`, source: m.part, severity: "high", category: "chybí výstup" });
    }
    // 3. Pending questions
    for (const q of karelPendingQuestions) {
      reqs.push({ text: q.question.slice(0, 200), source: `pro ${q.directed_to}`, severity: "medium", category: "otázka" });
    }
    // 4. Overdue commitments
    for (const c of karelCommitments) {
      const days = Math.floor((Date.now() - new Date(c.due).getTime()) / 86400000);
      reqs.push({ text: `${c.text.slice(0, 150)} (${days}d po termínu)`, source: c.by, severity: days > 3 ? "high" : "medium", category: "závazek" });
    }
    return reqs;
  }, [crisisCards, karelMissingSessions, karelPendingQuestions, karelCommitments]);

  if (loading) {
    return (
      <div className="jung-study min-h-screen">
        <div className="max-w-[900px] mx-auto px-4 py-6 space-y-6">
          <div className="animate-pulse rounded-2xl h-10 w-full" style={{ background: "hsl(var(--muted))" }} />
          <div className="animate-pulse rounded-2xl h-40 w-full" style={{ background: "hsl(var(--muted))" }} />
          <div className="animate-pulse rounded-2xl h-32 w-full" style={{ background: "hsl(var(--muted))" }} />
          <div className="animate-pulse rounded-2xl h-24 w-full" style={{ background: "hsl(var(--muted))" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="jung-study min-h-screen" data-no-swipe-back="true">
      <div className="max-w-[900px] mx-auto px-4 py-6 space-y-5 relative z-10">

        {/* ═══ 1. STATUS BAR ═══ */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted-foreground">
              {lastRefreshAt.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <div className="flex items-center gap-1">
              <div className={cn("w-1.5 h-1.5 rounded-full", realtimeConnected ? "bg-green-500" : "bg-muted-foreground/40")} />
              <span className="text-[11px] text-muted-foreground">{realtimeConnected ? "live" : "offline"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 px-3 text-[12px] gap-1 text-muted-foreground hover:text-foreground" onClick={() => setRefreshTrigger(p => p + 1)}>
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

        {/* ═══ 2. SYSTEM HEALTH ═══ */}
        {healthIssues.length > 0 && (
          <StudyCard accent="crisis">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <span className="text-[14px] font-semibold text-destructive">Systémový problém</span>
            </div>
            {healthIssues.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between gap-2 py-1">
                <span className="text-[13px] text-foreground">• {h.message}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[12px] h-6 px-2 text-muted-foreground hover:text-foreground"
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
          </StudyCard>
        )}

        {/* ═══ 3. CRISIS OPERATIONAL STRIP ═══ */}
        {crisisCards.length > 0 && (
          <StudyCard accent="crisis" className="space-y-3">
            {crisisCards.map((card) => {
              const id = card.eventId || card.alertId || card.partName;
              const stateLabel = card.operatingState ? STATE_LABELS[card.operatingState] || card.operatingState : "aktivní";
              const missingFlags: string[] = [];
              if (card.missingTodayInterview) missingFlags.push("interview");
              if (card.missingSessionResult) missingFlags.push("sezení");
              if (card.missingTherapistFeedback) missingFlags.push("feedback");
              if (card.unansweredQuestionCount > 0) missingFlags.push(`${card.unansweredQuestionCount}Q`);

              return (
                <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Shield className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-[14px] font-semibold text-foreground">{card.displayName}</span>
                  <span className="text-[11px] text-muted-foreground">{card.severity}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{stateLabel}</span>
                  {card.daysActive && <span className="text-[11px] text-muted-foreground">den {card.daysActive}</span>}
                  {card.isStale && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive font-medium">
                      {Math.round(card.hoursStale)}h bez kontaktu
                    </span>
                  )}
                  {missingFlags.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[hsl(38,60%,55%,0.2)] text-[hsl(38,50%,70%)] flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      chybí: {missingFlags.join(", ")}
                    </span>
                  )}
                  <div className="flex gap-2 ml-auto">
                    {card.computedCTAs.slice(0, 2).map(cta => (
                      <button
                        key={cta.key}
                        onClick={() => navigate(card.meetingId ? `/chat?meeting=${card.meetingId}` : `/chat?sub=meeting`)}
                        className={cn(
                          "text-[10px] px-2.5 py-1 rounded-md font-medium border transition-colors",
                          cta.priority === "critical"
                            ? "border-destructive/60 text-destructive hover:bg-destructive/10"
                            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        {cta.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </StudyCard>
        )}

        {/* ═══ 4. KAREL VYŽADUJE — command layer ═══ */}
        {karelRequirements.length > 0 && (
          <StudyCard accent="gold">
            <SectionTitle icon={<Zap className="w-4 h-4 text-primary" />}>
              Karel vyžaduje ({karelRequirements.length})
            </SectionTitle>
            <div className="space-y-3">
              {karelRequirements.map((req, i) => (
                <div key={i} className="flex items-start gap-3 text-[13px]">
                  <div className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5",
                    req.severity === "high" || req.severity === "critical" ? "bg-destructive/20" : "bg-primary/20"
                  )}>
                    <span className={cn(
                      "text-[10px] font-bold",
                      req.severity === "high" || req.severity === "critical" ? "text-destructive" : "text-primary"
                    )}>{i + 1}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground leading-relaxed">{req.text}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[11px] text-muted-foreground">{req.source}</span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                        req.category === "krize" ? "bg-destructive/15 text-destructive"
                          : req.category === "chybí výstup" ? "bg-[hsl(38,60%,55%,0.2)] text-[hsl(38,50%,70%)]"
                          : req.category === "závazek" ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}>{req.category}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </StudyCard>
        )}

        <div className="jung-divider" />

        {/* ═══ 5. KARLŮV PŘEHLED — hero section ═══ */}
        <div className="jung-hero-section rounded-2xl p-1">
          <ErrorBoundary fallbackTitle="Denní plán selhal">
            <KarelDailyPlan refreshTrigger={refreshTrigger} />
          </ErrorBoundary>
        </div>

        {/* ═══ 6. OTÁZKY ČEKAJÍCÍ NA ODPOVĚĎ ═══ */}
        <ErrorBoundary fallbackTitle="Otázky selhaly">
          <PendingQuestionsPanel refreshTrigger={refreshTrigger} />
        </ErrorBoundary>

        <div className="jung-divider" />

        {/* ═══ 7. ÚKOLY TÝMU ═══ */}
        <StudyCard>
          <div className="flex items-center justify-between mb-4">
            <SectionTitle icon={<span className="text-[16px]">📋</span>}>
              Úkoly týmu
            </SectionTitle>
            {pendingWriteCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/15 text-primary flex items-center gap-1">
                <Upload className="w-3 h-3" />{pendingWriteCount} čeká na Drive
              </span>
            )}
          </div>
          <ErrorBoundary fallbackTitle="Task board selhal">
            <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
          </ErrorBoundary>
        </StudyCard>

        {/* ═══ 8. PLÁNOVANÁ SEZENÍ ═══ */}
        <ErrorBoundary fallbackTitle="Plán sezení selhal">
          <DidDailySessionPlan refreshTrigger={refreshTrigger} />
        </ErrorBoundary>

        {/* ═══ 9. KOORDINAČNÍ UPOZORNĚNÍ ═══ */}
        <ErrorBoundary fallbackTitle="Koordinace selhala">
          <DidCoordinationAlerts refreshTrigger={refreshTrigger} />
        </ErrorBoundary>

        {/* ═══ 10. AKTIVNÍ KONVERZACE ═══ */}
        {activeThreads.length > 0 && (
          <StudyCard>
            <SectionTitle icon={<MessageSquare className="w-4 h-4 text-primary" />}>
              Kdo mluví s Karlem
            </SectionTitle>
            <div className="flex flex-wrap gap-2">
              {activeThreads.map(t => {
                if (isNonDidEntity(t.partName)) return null;
                return (
                  <button
                    key={t.id}
                    onClick={() => onQuickThread?.(t.id, t.partName)}
                    className="text-[13px] px-3 py-1.5 rounded-lg border border-border text-foreground transition-colors hover:bg-muted hover:border-primary/40"
                  >
                    {cleanDisplayName(t.partName)}
                    <span className="text-[11px] ml-1 text-muted-foreground">({t.messageCount})</span>
                  </button>
                );
              })}
            </div>
          </StudyCard>
        )}

        <div className="jung-divider" />

        {/* ═══ 11. DOHODY ═══ */}
        <ErrorBoundary fallbackTitle="Dohody selhaly">
          <StudyCard>
            <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger(p => p + 1)} />
          </StudyCard>
        </ErrorBoundary>

        {/* ═══ 12. MĚSÍČNÍ PŘEHLEDY ═══ */}
        <ErrorBoundary fallbackTitle="Měsíční panel selhal">
          <StudyCard>
            <DidMonthlyPanel refreshTrigger={refreshTrigger} />
          </StudyCard>
        </ErrorBoundary>

        {/* ═══ 13. MAPA SYSTÉMU ═══ */}
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

        {/* ═══ 14. SUPERVIZNÍ REPORT ═══ */}
        <ErrorBoundary fallbackTitle="Supervizní report selhal">
          <StudyCard>
            <DidSupervisionReport refreshTrigger={refreshTrigger} />
          </StudyCard>
        </ErrorBoundary>

        {/* ═══ 15. NEAKTIVNÍ ČÁSTI ═══ */}
        {warningParts.length > 0 && (
          <StudyCard accent="warning">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-primary" />
              <span className="text-[14px] font-semibold text-foreground">Neaktivní části</span>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {warningParts.map(p => cleanDisplayName(p.name)).join(", ")} – neaktivní více než 7 dní.
            </p>
          </StudyCard>
        )}

        {/* ═══ FOOTER ═══ */}
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl text-[12px] text-muted-foreground bg-muted/30">
          <span>Části: <strong className="text-foreground">{parts.filter(p => p.status === "active").length}</strong> aktivních</span>
          <span>•</span>
          <span>Vlákna: <strong className="text-foreground">{activeThreads.length}</strong></span>
        </div>
      </div>
    </div>
  );
};

export default DidDashboard;
