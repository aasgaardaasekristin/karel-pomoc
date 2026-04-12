import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { X, Shield, MessageSquare, RefreshCw, Activity, ChevronDown, ChevronUp, CheckCircle } from "lucide-react";
import { cleanDisplayName } from "@/lib/didPartNaming";
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
  updated_at: string | null;
  sessions_count: number | null;
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

interface DeduplicatedCrisis {
  partName: string;
  displayName: string;
  days: number | null;
  phase: string | null;
  severity: string;
  alertId: string | null;
  eventId: string | null;
  conversationId: string | null;
  lastUpdate: string | null;
  sessionsCount: number | null;
}

const PHASE_LABELS: Record<string, string> = {
  acute: "akutní",
  stabilizing: "stabilizace",
  diagnostic: "diagnostika",
  closing: "uzavírání",
};

function timeSince(iso: string | null): string {
  if (!iso) return "neznámé";
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<CrisisAlertData[]>([]);
  const [crisisEvents, setCrisisEvents] = useState<CrisisEventData[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CrisisTaskData[]>([]);
  const [resolveNotes, setResolveNotes] = useState("");
  const [showResolveInput, setShowResolveInput] = useState(false);
  const [evalLoading, setEvalLoading] = useState(false);

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
    if (data) setAlerts(data as CrisisAlertData[]);
  }, []);

  const fetchCrisisEvents = useCallback(async () => {
    const { data } = await supabase
      .from("crisis_events")
      .select("id, part_name, phase, severity, banner_dismissed, banner_dismissed_at, days_active, updated_at, sessions_count")
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
    if (expandedId) {
      const alert = alerts.find(a => a.id === expandedId);
      if (alert) fetchTasks(alert.id);
    }
  }, [expandedId, alerts, fetchTasks]);

  const handleAcknowledge = async (alertId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase.from("crisis_alerts").update({
      status: "ACKNOWLEDGED",
      acknowledged_by: userName,
      acknowledged_at: new Date().toISOString(),
    }).eq("id", alertId);
    fetchAlerts();
  };

  const handleEvaluate = async (eventId: string) => {
    setEvalLoading(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`https://${projectId}.supabase.co/functions/v1/evaluate-crisis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ crisisId: eventId }),
      });
      fetchCrisisEvents();
      fetchAlerts();
    } catch { /* silent */ }
    setEvalLoading(false);
  };

  const handleResolve = async (alertId: string) => {
    if (!resolveNotes.trim()) return;
    await supabase.from("crisis_alerts").update({
      status: "RESOLVED",
      resolved_at: new Date().toISOString(),
      resolution_notes: resolveNotes,
    }).eq("id", alertId);
    setExpandedId(null);
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
    if (expandedId) {
      const alert = alerts.find(a => a.id === expandedId);
      if (alert) fetchTasks(alert.id);
    }
  };

  // ── DEDUPLICATE by part_name ──
  const deduplicated = React.useMemo<DeduplicatedCrisis[]>(() => {
    const map = new Map<string, DeduplicatedCrisis>();

    for (const ce of crisisEvents) {
      const key = ce.part_name.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          partName: ce.part_name,
          displayName: cleanDisplayName(ce.part_name),
          days: ce.days_active,
          phase: ce.phase,
          severity: ce.severity,
          alertId: null,
          eventId: ce.id,
          conversationId: null,
          lastUpdate: ce.updated_at,
          sessionsCount: ce.sessions_count,
        });
      }
    }

    for (const a of alerts) {
      const key = a.part_name.toUpperCase();
      const existing = map.get(key);
      if (existing) {
        existing.alertId = a.id;
        existing.conversationId = a.conversation_id;
        if (!existing.days && a.days_in_crisis) existing.days = a.days_in_crisis;
      } else {
        map.set(key, {
          partName: a.part_name,
          displayName: cleanDisplayName(a.part_name),
          days: a.days_in_crisis,
          phase: null,
          severity: a.severity,
          alertId: a.id,
          eventId: null,
          conversationId: a.conversation_id,
          lastUpdate: a.created_at,
          sessionsCount: null,
        });
      }
    }

    return Array.from(map.values());
  }, [crisisEvents, alerts]);

  const visibleCrises = deduplicated.filter(c => {
    const id = c.eventId || c.alertId || "";
    return !dismissedIds.has(id);
  });

  if (visibleCrises.length === 0) return null;

  const expandedCrisis = visibleCrises.find(c => (c.eventId || c.alertId) === expandedId);
  const expandedAlert = expandedCrisis?.alertId ? alerts.find(a => a.id === expandedCrisis.alertId) : null;

  return (
    <>
      {/* Compact operational banner per crisis */}
      <div className="sticky top-0 z-50">
        {visibleCrises.map(c => {
          const id = c.eventId || c.alertId || c.partName;
          const isExpanded = expandedId === id;
          const staleHours = c.lastUpdate ? Math.floor((Date.now() - new Date(c.lastUpdate).getTime()) / 3600000) : null;
          const isStale = staleHours !== null && staleHours > 24;

          return (
            <div key={id}>
              {/* Banner line */}
              <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
                <div className="max-w-[900px] mx-auto flex items-center gap-3 text-[13px]">
                  {/* Left: core info */}
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Shield className="w-4 h-4 shrink-0" />
                    <span className="font-bold truncate">{c.displayName}</span>
                    <span className="text-white/60 text-[11px] shrink-0">
                      {c.phase ? PHASE_LABELS[c.phase] || c.phase : "aktivní"}
                      {c.days ? ` · den ${c.days}` : ""}
                    </span>
                    {isStale && (
                      <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded shrink-0">
                        ⚠ update {timeSince(c.lastUpdate)}
                      </span>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {c.eventId && (
                      <button
                        onClick={() => handleEvaluate(c.eventId!)}
                        disabled={evalLoading}
                        className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                        title="Spustit přehodnocení krize"
                      >
                        <RefreshCw className={`w-3 h-3 ${evalLoading ? "animate-spin" : ""}`} />
                        Hodnocení
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (c.conversationId) navigate(`/chat?meeting=${c.conversationId}`);
                        else navigate(`/chat?sub=meeting`);
                      }}
                      className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                    >
                      <MessageSquare className="w-3 h-3" />
                      Porada
                    </button>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : id)}
                      className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors"
                      title={isExpanded ? "Skrýt detail" : "Zobrazit detail"}
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => handleDismiss(id)}
                      className="hover:bg-white/10 p-1 rounded"
                      title="Skrýt banner"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Expandable detail card */}
              {isExpanded && (
                <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
                  <div className="p-4 space-y-4 text-sm max-h-[60vh] overflow-y-auto">
                    {/* Status grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-muted/50 rounded-lg p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">Fáze</p>
                        <p className="font-bold text-foreground text-xs">{c.phase ? PHASE_LABELS[c.phase] || c.phase : "—"}</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">Dní aktivní</p>
                        <p className="font-bold text-foreground text-xs">{c.days ?? "—"}</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">Poslední update</p>
                        <p className={`font-bold text-xs ${isStale ? "text-destructive" : "text-foreground"}`}>
                          {timeSince(c.lastUpdate)}
                        </p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5 text-center">
                        <p className="text-[10px] text-muted-foreground">Sezení</p>
                        <p className="font-bold text-foreground text-xs">{c.sessionsCount ?? "—"}</p>
                      </div>
                    </div>

                    {/* What Karel needs */}
                    {isStale && (
                      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                        <p className="text-xs font-bold text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
                          <Activity className="w-3.5 h-3.5" />
                          Karel vyžaduje
                        </p>
                        <ul className="text-xs text-blue-700 dark:text-blue-400 mt-1.5 space-y-1 list-disc list-inside">
                          <li>Čerstvý update od terapeutky ({c.displayName})</li>
                          <li>Aktuální bezpečnostní posouzení</li>
                          <li>Rozhodnutí o dalším postupu</li>
                        </ul>
                      </div>
                    )}

                    {/* Intervention plan (if exists, short) */}
                    {expandedAlert?.intervention_plan && (
                      <div>
                        <h4 className="text-xs font-bold text-foreground mb-1">Plán intervence</h4>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{expandedAlert.intervention_plan}</p>
                      </div>
                    )}

                    {/* Trigger signals */}
                    {expandedAlert?.trigger_signals && expandedAlert.trigger_signals.length > 0 && (
                      <div>
                        <h4 className="text-xs font-bold text-foreground mb-1">Signály</h4>
                        <div className="flex flex-wrap gap-1">
                          {expandedAlert.trigger_signals.map((s, i) => (
                            <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">{s}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Tasks */}
                    {tasks.length > 0 && (
                      <div>
                        <h4 className="text-xs font-bold text-foreground mb-2">Úkoly</h4>
                        <div className="space-y-1.5">
                          {tasks.map(t => (
                            <label key={t.id} className="flex items-start gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={t.status === "DONE"}
                                onChange={() => handleToggleTask(t)}
                                className="mt-0.5 accent-destructive"
                              />
                              <div>
                                <p className={`text-xs font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>
                                <p className="text-[10px] text-muted-foreground">Pro: {t.assigned_to}</p>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2 pt-1 border-t">
                      {c.eventId && (
                        <button
                          onClick={() => handleEvaluate(c.eventId!)}
                          disabled={evalLoading}
                          className="text-xs px-3 py-1.5 rounded-md bg-muted hover:bg-muted/80 text-foreground flex items-center gap-1.5 transition-colors"
                        >
                          <RefreshCw className={`w-3 h-3 ${evalLoading ? "animate-spin" : ""}`} />
                          Spustit hodnocení
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (c.conversationId) navigate(`/chat?meeting=${c.conversationId}`);
                          else navigate(`/chat?sub=meeting`);
                        }}
                        className="text-xs px-3 py-1.5 rounded-md bg-muted hover:bg-muted/80 text-foreground flex items-center gap-1.5 transition-colors"
                      >
                        <MessageSquare className="w-3 h-3" />
                        Krizová porada
                      </button>
                      {expandedAlert && !expandedAlert.acknowledged_by && (
                        <button
                          onClick={() => handleAcknowledge(expandedAlert.id)}
                          className="text-xs px-3 py-1.5 rounded-md bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 flex items-center gap-1.5 transition-colors"
                        >
                          <CheckCircle className="w-3 h-3" />
                          Vzít na vědomí
                        </button>
                      )}
                      {expandedAlert && !showResolveInput && (
                        <button
                          onClick={() => setShowResolveInput(true)}
                          className="text-xs px-3 py-1.5 rounded-md bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/50 text-green-800 dark:text-green-300 flex items-center gap-1.5 transition-colors"
                        >
                          <CheckCircle className="w-3 h-3" />
                          Vyřešit krizi
                        </button>
                      )}
                    </div>

                    {/* Resolve input */}
                    {showResolveInput && expandedAlert && (
                      <div className="space-y-2 pt-2 border-t">
                        <textarea
                          value={resolveNotes}
                          onChange={e => setResolveNotes(e.target.value)}
                          placeholder="Popište jak byla krize vyřešena..."
                          className="w-full border rounded-lg p-3 text-xs min-h-[60px] bg-background text-foreground"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleResolve(expandedAlert.id)}
                            disabled={!resolveNotes.trim()}
                            className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition-colors"
                          >
                            Potvrdit vyřešení
                          </button>
                          <button
                            onClick={() => setShowResolveInput(false)}
                            className="px-3 py-1.5 border rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
                          >
                            Zrušit
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
};

export default CrisisAlert;
