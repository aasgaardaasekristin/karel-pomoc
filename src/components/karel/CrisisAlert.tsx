import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle, X, Shield, MessageSquare } from "lucide-react";
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

interface CrisisJournalEntry {
  crisis_trend: string | null;
  karel_action: string | null;
  session_summary: string | null;
  date: string | null;
}

interface DeduplicatedCrisis {
  partName: string;
  days: number | null;
  phase: string | null;
  severity: string;
  alertId: string | null;
  eventId: string | null;
  conversationId: string | null;
  summary: string | null;
  journal: CrisisJournalEntry | null;
}

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<CrisisAlertData[]>([]);
  const [crisisEvents, setCrisisEvents] = useState<CrisisEventData[]>([]);
  const [detailAlert, setDetailAlert] = useState<CrisisAlertData | null>(null);
  const [tasks, setTasks] = useState<CrisisTaskData[]>([]);
  const [resolveNotes, setResolveNotes] = useState("");
  const [showResolveInput, setShowResolveInput] = useState(false);
  const [journalMap, setJournalMap] = useState<Record<string, CrisisJournalEntry>>({});

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("dismissed_crisis_banners");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const handleDismiss = (id: string) => {
    setDismissedIds(prev => {
      const next = new Set(prev).add(id);
      localStorage.setItem("dismissed_crisis_banners", JSON.stringify([...next]));
      return next;
    });
  };

  const fetchAlerts = useCallback(async () => {
    const { data } = await supabase
      .from("crisis_alerts")
      .select("*")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"])
      .order("created_at", { ascending: false });
    if (data) {
      setAlerts(data as CrisisAlertData[]);
      // Fetch journal entries for each alert
      const journalEntries: Record<string, CrisisJournalEntry> = {};
      for (const alert of data) {
        const { data: journal } = await (supabase as any)
          .from("crisis_journal")
          .select("crisis_trend, karel_action, session_summary, date")
          .eq("crisis_alert_id", alert.id)
          .order("date", { ascending: false })
          .limit(1);
        if (journal?.[0]) journalEntries[alert.id] = journal[0];
      }
      setJournalMap(journalEntries);
    }
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

  // ── DEDUPLICATE: merge crisis_events + crisis_alerts by part_name ──
  const deduplicated = React.useMemo<DeduplicatedCrisis[]>(() => {
    const map = new Map<string, DeduplicatedCrisis>();

    // Events take priority
    for (const ce of crisisEvents) {
      const key = ce.part_name.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          partName: ce.part_name,
          days: ce.days_active,
          phase: ce.phase,
          severity: ce.severity,
          alertId: null,
          eventId: ce.id,
          conversationId: null,
          summary: null,
          journal: null,
        });
      }
    }

    // Alerts fill gaps or enrich
    for (const a of alerts) {
      const key = a.part_name.toUpperCase();
      const existing = map.get(key);
      if (existing) {
        existing.alertId = a.id;
        existing.conversationId = a.conversation_id;
        existing.summary = a.summary;
        existing.journal = journalMap[a.id] || null;
        if (!existing.days && a.days_in_crisis) existing.days = a.days_in_crisis;
      } else {
        map.set(key, {
          partName: a.part_name,
          days: a.days_in_crisis,
          phase: null,
          severity: a.severity,
          alertId: a.id,
          eventId: null,
          conversationId: a.conversation_id,
          summary: a.summary,
          journal: journalMap[a.id] || null,
        });
      }
    }

    return Array.from(map.values());
  }, [crisisEvents, alerts, journalMap]);

  const visibleCrises = deduplicated.filter(c => {
    const id = c.eventId || c.alertId || "";
    return !dismissedIds.has(id);
  });

  if (visibleCrises.length === 0) return null;

  return (
    <>
      {/* Single-line deduplicated banner per part */}
      <div className="sticky top-0 z-50">
        {visibleCrises.map(c => {
          const id = c.eventId || c.alertId || c.partName;
          return (
            <div key={id} className="text-white px-4 py-1.5" style={{ backgroundColor: "#7C2D2D", maxHeight: 40 }}>
              <div className="max-w-[900px] mx-auto flex items-center gap-2 text-[14px]">
                <span className="font-bold truncate">
                  🔴 KRIZE: {c.partName}{c.days ? ` — den ${c.days}` : ""}{c.phase ? ` | fáze: ${c.phase}` : ""}
                </span>
                <span className="text-white/40">|</span>
                <button
                  onClick={() => {
                    const alert = alerts.find(a => a.part_name.toUpperCase() === c.partName.toUpperCase());
                    if (alert) setDetailAlert(alert);
                  }}
                  className="hover:underline whitespace-nowrap"
                >
                  Otevřít vlákno
                </button>
                <span className="text-white/40">|</span>
                <button
                  onClick={() => {
                    if (c.conversationId) navigate(`/chat?meeting=${c.conversationId}`);
                    else navigate(`/chat?sub=meeting`);
                  }}
                  className="hover:underline whitespace-nowrap flex items-center gap-1"
                >
                  <MessageSquare className="w-3 h-3" />Krizová porada
                </button>
                <button
                  onClick={() => handleDismiss(id)}
                  className="ml-auto hover:bg-white/10 p-0.5 rounded"
                  title="Skrýt (24h)"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail modal */}
      {detailAlert && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <div className="text-white px-6 py-4 rounded-t-xl flex items-center justify-between" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                <span className="font-bold">Krizový detail – {detailAlert.part_name}</span>
              </div>
              <button onClick={() => { setDetailAlert(null); setShowResolveInput(false); }}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-5 text-sm">
              <div><h3 className="font-bold text-foreground mb-1">Souhrn</h3><p className="text-muted-foreground">{detailAlert.summary}</p></div>
              <div className="flex gap-4 text-xs">
                <span className="px-2 py-1 rounded font-bold" style={{ backgroundColor: "#7C2D2D20", color: "#7C2D2D" }}>{detailAlert.severity}</span>
                <span className="text-muted-foreground">Detekováno: {formatTime(detailAlert.created_at)}</span>
              </div>
              {detailAlert.trigger_signals && detailAlert.trigger_signals.length > 0 && (
                <div><h3 className="font-bold text-foreground mb-1">Signály</h3><div className="flex flex-wrap gap-1">{detailAlert.trigger_signals.map((s, i) => (<span key={i} className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "#7C2D2D15", color: "#7C2D2D" }}>{s}</span>))}</div></div>
              )}
              {detailAlert.karel_assessment && (<div><h3 className="font-bold text-foreground mb-1">Karlovo vyhodnocení</h3><p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.karel_assessment}</p></div>)}
              {detailAlert.intervention_plan && (<div><h3 className="font-bold text-foreground mb-1">Plán intervence</h3><p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.intervention_plan}</p></div>)}
              {detailAlert.conversation_excerpts && (<div><h3 className="font-bold text-foreground mb-1">Úryvky z konverzace</h3><div className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">{detailAlert.conversation_excerpts}</div></div>)}
              {tasks.length > 0 && (
                <div><h3 className="font-bold text-foreground mb-2">Úkoly</h3><div className="space-y-2">{tasks.map(t => (<label key={t.id} className="flex items-start gap-2 cursor-pointer"><input type="checkbox" checked={t.status === "DONE"} onChange={() => handleToggleTask(t)} className="mt-0.5" style={{ accentColor: "#7C2D2D" }} /><div><p className={`text-sm font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>{t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}<p className="text-xs text-muted-foreground">Pro: {t.assigned_to}</p></div></label>))}</div></div>
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
