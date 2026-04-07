import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, CheckCircle, X, Shield, MessageSquare, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { cs } from "date-fns/locale";

interface CrisisAlertData {
  id: string;
  created_at: string;
  part_name: string;
  severity: string;
  status: string;
  summary: string;
  trigger_signals: string[] | null;
  conversation_excerpts: string | null;
  karel_assessment: string | null;
  intervention_plan: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  crisis_thread_id: string | null;
  conversation_id: string | null;
  days_in_crisis: number | null;
}

interface CrisisEventData {
  id: string;
  part_name: string;
  phase: string;
  severity: string;
  banner_dismissed: boolean;
  banner_dismissed_at: string | null;
  days_active: number | null;
}

interface CrisisTaskData {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  priority: string;
  status: string;
  completed_at: string | null;
}

const PHASE_BANNER_COLORS: Record<string, string> = {
  acute: "bg-red-900",
  stabilizing: "bg-amber-900",
  diagnostic: "bg-blue-900",
  closing: "bg-green-900",
};

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<CrisisAlertData[]>([]);
  const [crisisEvents, setCrisisEvents] = useState<CrisisEventData[]>([]);
  const [detailAlert, setDetailAlert] = useState<CrisisAlertData | null>(null);
  const [tasks, setTasks] = useState<CrisisTaskData[]>([]);
  const [resolveNotes, setResolveNotes] = useState("");
  const [showResolveInput, setShowResolveInput] = useState(false);

  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("dismissed_crisis_alerts");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const handleDismissAlert = (alertId: string) => {
    setDismissedAlertIds(prev => {
      const next = new Set(prev).add(alertId);
      localStorage.setItem("dismissed_crisis_alerts", JSON.stringify([...next]));
      return next;
    });
  };

  // Re-show dismissed alerts when status changes
  useEffect(() => {
    const statusMap = new Map(alerts.map(a => [a.id, a.status]));
    setDismissedAlertIds(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of prev) {
        if (!statusMap.has(id)) { next.delete(id); changed = true; }
      }
      if (changed) localStorage.setItem("dismissed_crisis_alerts", JSON.stringify([...next]));
      return changed ? next : prev;
    });
  }, [alerts]);

  const fetchAlerts = useCallback(async () => {
    const { data } = await supabase
      .from("crisis_alerts")
      .select("*")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"])
      .order("created_at", { ascending: false });
    if (data) setAlerts(data as CrisisAlertData[]);
  }, []);

  const fetchCrisisEvents = useCallback(async () => {
    const { data } = await supabase
      .from("crisis_events")
      .select("id, part_name, phase, severity, banner_dismissed, banner_dismissed_at, days_active")
      .not("phase", "eq", "closed")
      .order("created_at", { ascending: false });
    if (data) setCrisisEvents(data as CrisisEventData[]);
  }, []);

  const fetchTasks = useCallback(async (alertId: string) => {
    const { data } = await supabase
      .from("crisis_tasks")
      .select("*")
      .eq("crisis_alert_id", alertId)
      .order("created_at", { ascending: true });
    if (data) setTasks(data as CrisisTaskData[]);
  }, []);

  useEffect(() => {
    fetchAlerts();
    fetchCrisisEvents();

    const channel = supabase
      .channel("crisis-alerts-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_alerts" }, () => fetchAlerts())
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_events" }, () => fetchCrisisEvents())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchAlerts, fetchCrisisEvents]);

  useEffect(() => {
    if (detailAlert) fetchTasks(detailAlert.id);
  }, [detailAlert, fetchTasks]);

  const handleAcknowledge = async (alert: CrisisAlertData) => {
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase.from("crisis_alerts").update({
      status: "ACKNOWLEDGED",
      acknowledged_by: userName,
      acknowledged_at: new Date().toISOString(),
    }).eq("id", alert.id);
    fetchAlerts();
  };

  const handleResolve = async (alert: CrisisAlertData) => {
    if (!resolveNotes.trim()) return;
    await supabase.from("crisis_alerts").update({
      status: "RESOLVED",
      resolved_at: new Date().toISOString(),
      resolution_notes: resolveNotes,
    }).eq("id", alert.id);
    setDetailAlert(null);
    setResolveNotes("");
    setShowResolveInput(false);
    fetchAlerts();
  };

  const handleDismissCrisisEvent = async (eventId: string) => {
    await supabase.from("crisis_events").update({
      banner_dismissed: true,
      banner_dismissed_at: new Date().toISOString(),
    }).eq("id", eventId);
    localStorage.setItem(`crisis_dismissed_${eventId}`, new Date().toISOString());
    fetchCrisisEvents();
  };

  const handleToggleTask = async (task: CrisisTaskData) => {
    const newStatus = task.status === "DONE" ? "PENDING" : "DONE";
    await supabase.from("crisis_tasks").update({
      status: newStatus,
      completed_at: newStatus === "DONE" ? new Date().toISOString() : null,
    }).eq("id", task.id);
    if (detailAlert) fetchTasks(detailAlert.id);
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return `dnes v ${format(d, "HH:mm", { locale: cs })}`;
      return format(d, "d. M. yyyy HH:mm", { locale: cs });
    } catch { return iso; }
  };

  // Filter dismissed crisis events (re-show after 24h or phase change)
  const visibleCrisisEvents = crisisEvents.filter(ce => {
    if (!ce.banner_dismissed) return true;
    const dismissedAt = ce.banner_dismissed_at ? new Date(ce.banner_dismissed_at).getTime() : 0;
    const localDismissed = localStorage.getItem(`crisis_dismissed_${ce.id}`);
    const localTime = localDismissed ? new Date(localDismissed).getTime() : 0;
    const dismissTime = Math.max(dismissedAt, localTime);
    // Re-show after 24h
    return Date.now() - dismissTime > 24 * 60 * 60 * 1000;
  });

  const visibleAlerts = alerts.filter(a => !dismissedAlertIds.has(a.id));

  if (visibleAlerts.length === 0 && visibleCrisisEvents.length === 0) return null;

  return (
    <>
      <div className="sticky top-0 z-50">
        {/* Crisis events (lifecycle) banners */}
        {visibleCrisisEvents.map(ce => (
          <div key={ce.id} className={`${PHASE_BANNER_COLORS[ce.phase] || "bg-red-900"} text-white px-4 py-1.5`}>
            <div className="max-w-4xl mx-auto flex items-center gap-2 text-xs">
              <span className="font-bold truncate">
                🔴 KRIZE: {ce.part_name}{ce.days_active ? ` — den ${ce.days_active}` : ""}
              </span>
              <span className="text-white/40">|</span>
              <button onClick={() => setDetailAlert(alerts.find(a => a.part_name === ce.part_name) || null)} className="hover:underline whitespace-nowrap">Otevřít detail</button>
              <span className="text-white/40">|</span>
              <button onClick={() => navigate("/chat?sub=meeting")} className="hover:underline whitespace-nowrap flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />Krizová porada
              </button>
              <button onClick={() => handleDismissCrisisEvent(ce.id)} className="ml-auto hover:bg-white/10 p-0.5 rounded" title="Skrýt (24h)">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}

        {/* Legacy crisis_alerts — single-line compact banner */}
        {visibleAlerts.map((alert) => (
          <div key={alert.id} className="bg-red-900 text-white px-4 py-1.5">
            <div className="max-w-4xl mx-auto flex items-center gap-2 text-xs">
              <span className="font-bold truncate">
                🔴 KRIZE: {alert.part_name}{alert.days_in_crisis ? ` — den ${alert.days_in_crisis}` : ""}
              </span>
              <span className="text-white/40">|</span>
              <button onClick={() => setDetailAlert(alert)} className="hover:underline whitespace-nowrap">Otevřít detail</button>
              <span className="text-white/40">|</span>
              <button onClick={() => { if (alert.conversation_id) navigate(`/chat?meeting=${alert.conversation_id}`); else navigate(`/chat?sub=meeting`); }} className="hover:underline whitespace-nowrap flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />Krizová porada
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleDismissAlert(alert.id); }} className="ml-auto hover:bg-white/10 p-0.5 rounded" title="Skrýt">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Detail modal */}
      {detailAlert && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <div className={`${detailAlert.status === "ACKNOWLEDGED" ? "bg-orange-500" : "bg-red-600"} text-white px-6 py-4 rounded-t-xl flex items-center justify-between`}>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                <span className="font-bold">Krizový detail – {detailAlert.part_name}</span>
              </div>
              <button onClick={() => { setDetailAlert(null); setShowResolveInput(false); }}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-5 text-sm">
              <div><h3 className="font-bold text-foreground mb-1">Souhrn</h3><p className="text-muted-foreground">{detailAlert.summary}</p></div>
              <div className="flex gap-4 text-xs">
                <span className={`px-2 py-1 rounded font-bold ${detailAlert.severity === "CRITICAL" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" : "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"}`}>{detailAlert.severity}</span>
                <span className="text-muted-foreground">Detekováno: {formatTime(detailAlert.created_at)}</span>
              </div>
              {detailAlert.trigger_signals && detailAlert.trigger_signals.length > 0 && (
                <div><h3 className="font-bold text-foreground mb-1">Signály</h3><div className="flex flex-wrap gap-1">{detailAlert.trigger_signals.map((s, i) => (<span key={i} className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs px-2 py-0.5 rounded-full">{s}</span>))}</div></div>
              )}
              {detailAlert.karel_assessment && (<div><h3 className="font-bold text-foreground mb-1">Karlovo vyhodnocení</h3><p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.karel_assessment}</p></div>)}
              {detailAlert.intervention_plan && (<div><h3 className="font-bold text-foreground mb-1">Plán intervence</h3><p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.intervention_plan}</p></div>)}
              {detailAlert.conversation_excerpts && (<div><h3 className="font-bold text-foreground mb-1">Úryvky z konverzace</h3><div className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">{detailAlert.conversation_excerpts}</div></div>)}
              {tasks.length > 0 && (
                <div><h3 className="font-bold text-foreground mb-2">Úkoly</h3><div className="space-y-2">{tasks.map(t => (<label key={t.id} className="flex items-start gap-2 cursor-pointer"><input type="checkbox" checked={t.status === "DONE"} onChange={() => handleToggleTask(t)} className="mt-0.5 accent-red-600" /><div><p className={`text-sm font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>{t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}<p className="text-xs text-muted-foreground">Pro: {t.assigned_to}</p></div></label>))}</div></div>
              )}
              {!showResolveInput ? (
                <button onClick={() => setShowResolveInput(true)} className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"><CheckCircle className="w-4 h-4" />KRIZE VYŘEŠENA</button>
              ) : (
                <div className="space-y-2">
                  <textarea value={resolveNotes} onChange={e => setResolveNotes(e.target.value)} placeholder="Popište jak byla krize vyřešena (povinné)..." className="w-full border rounded-lg p-3 text-sm min-h-[80px] bg-background text-foreground" />
                  <div className="flex gap-2">
                    <button onClick={() => handleResolve(detailAlert)} disabled={!resolveNotes.trim()} className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-2 px-4 rounded-lg transition-colors">Potvrdit vyřešení</button>
                    <button onClick={() => setShowResolveInput(false)} className="px-4 py-2 border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors">Zrušit</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CrisisAlert;
