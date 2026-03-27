import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, CheckCircle, X, Shield, MessageSquare } from "lucide-react";
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

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<CrisisAlertData[]>([]);
  const [detailAlert, setDetailAlert] = useState<CrisisAlertData | null>(null);
  const [tasks, setTasks] = useState<CrisisTaskData[]>([]);
  const [resolveNotes, setResolveNotes] = useState("");
  const [showResolveInput, setShowResolveInput] = useState(false);

  const fetchAlerts = useCallback(async () => {
    const { data } = await supabase
      .from("crisis_alerts")
      .select("*")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"])
      .order("created_at", { ascending: false });
    if (data) setAlerts(data as CrisisAlertData[]);
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

    const channel = supabase
      .channel("crisis-alerts-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crisis_alerts" },
        () => { fetchAlerts(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchAlerts]);

  useEffect(() => {
    if (detailAlert) fetchTasks(detailAlert.id);
  }, [detailAlert, fetchTasks]);

  const handleAcknowledge = async (alert: CrisisAlertData) => {
    const { data: { user } } = await supabase.auth.getUser();
    const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
    await supabase
      .from("crisis_alerts")
      .update({
        status: "ACKNOWLEDGED",
        acknowledged_by: userName,
        acknowledged_at: new Date().toISOString(),
      })
      .eq("id", alert.id);
    fetchAlerts();
  };

  const handleResolve = async (alert: CrisisAlertData) => {
    if (!resolveNotes.trim()) return;
    await supabase
      .from("crisis_alerts")
      .update({
        status: "RESOLVED",
        resolved_at: new Date().toISOString(),
        resolution_notes: resolveNotes,
      })
      .eq("id", alert.id);
    setDetailAlert(null);
    setResolveNotes("");
    setShowResolveInput(false);
    fetchAlerts();
  };

  const handleToggleTask = async (task: CrisisTaskData) => {
    const newStatus = task.status === "DONE" ? "PENDING" : "DONE";
    await supabase
      .from("crisis_tasks")
      .update({
        status: newStatus,
        completed_at: newStatus === "DONE" ? new Date().toISOString() : null,
      })
      .eq("id", task.id);
    if (detailAlert) fetchTasks(detailAlert.id);
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) {
        return `dnes v ${format(d, "HH:mm", { locale: cs })}`;
      }
      return format(d, "d. M. yyyy HH:mm", { locale: cs });
    } catch { return iso; }
  };

  if (alerts.length === 0) return null;

  return (
    <>
      {/* Sticky crisis banners */}
      <div className="sticky top-0 z-50">
        {alerts.map((alert) => {
          const isAcknowledged = alert.status === "ACKNOWLEDGED";
          return (
            <div
              key={alert.id}
              className={`${
                isAcknowledged
                  ? "bg-orange-500"
                  : "bg-red-600 animate-pulse"
              } text-white px-4 py-3 shadow-lg`}
            >
              <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <div className="min-w-0">
                    {isAcknowledged ? (
                      <p className="font-bold text-sm">
                        ⚠️ KRIZE POTVRZENA – řeší {alert.acknowledged_by}.
                        Zahájeno: {alert.acknowledged_at ? formatTime(alert.acknowledged_at) : "—"}
                      </p>
                    ) : (
                      <>
                        <p className="font-bold text-sm">
                          ⚠️ KRIZOVÁ SITUACE – {alert.part_name}
                        </p>
                        <p className="text-xs opacity-90 truncate">{alert.summary}</p>
                        <p className="text-xs opacity-75">
                          Úroveň: {alert.severity} · Detekováno: {formatTime(alert.created_at)}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0 flex-wrap">
                  <button
                    onClick={() => setDetailAlert(alert)}
                    className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
                  >
                    OTEVŘÍT DETAIL
                  </button>
                   {alert.conversation_id && (
                    <button
                      onClick={() => {
                        // Navigate to meeting panel with crisis meeting
                        window.location.href = `/chat?meeting=${alert.conversation_id}`;
                      }}
                      className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors flex items-center gap-1"
                    >
                      <MessageSquare className="w-3 h-3" />
                      KRIZOVÁ PORADA
                    </button>
                  )}
                  {!alert.conversation_id && alert.crisis_thread_id && (
                    <button
                      onClick={() => {
                        window.location.href = `/chat?crisisThread=${alert.crisis_thread_id}`;
                      }}
                      className="bg-white/20 hover:bg-white/30 text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors flex items-center gap-1"
                    >
                      <MessageSquare className="w-3 h-3" />
                      KRIZOVÉ VLÁKNO
                    </button>
                  )}
                  {!isAcknowledged && (
                    <button
                      onClick={() => handleAcknowledge(alert)}
                      className="bg-white text-red-700 text-xs font-bold px-3 py-1.5 rounded hover:bg-white/90 transition-colors"
                    >
                      PŘEBÍRÁM ŘÍZENÍ
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail modal */}
      {detailAlert && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            {/* Header */}
            <div className={`${detailAlert.status === "ACKNOWLEDGED" ? "bg-orange-500" : "bg-red-600"} text-white px-6 py-4 rounded-t-xl flex items-center justify-between`}>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5" />
                <span className="font-bold">Krizový detail – {detailAlert.part_name}</span>
              </div>
              <button onClick={() => { setDetailAlert(null); setShowResolveInput(false); }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 text-sm">
              {/* Summary */}
              <div>
                <h3 className="font-bold text-foreground mb-1">Souhrn</h3>
                <p className="text-muted-foreground">{detailAlert.summary}</p>
              </div>

              {/* Severity + time */}
              <div className="flex gap-4 text-xs">
                <span className={`px-2 py-1 rounded font-bold ${detailAlert.severity === "CRITICAL" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" : "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"}`}>
                  {detailAlert.severity}
                </span>
                <span className="text-muted-foreground">Detekováno: {formatTime(detailAlert.created_at)}</span>
              </div>

              {/* Trigger signals */}
              {detailAlert.trigger_signals && detailAlert.trigger_signals.length > 0 && (
                <div>
                  <h3 className="font-bold text-foreground mb-1">Signály</h3>
                  <div className="flex flex-wrap gap-1">
                    {detailAlert.trigger_signals.map((s, i) => (
                      <span key={i} className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs px-2 py-0.5 rounded-full">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Karel assessment */}
              {detailAlert.karel_assessment && (
                <div>
                  <h3 className="font-bold text-foreground mb-1">Karlovo vyhodnocení</h3>
                  <p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.karel_assessment}</p>
                </div>
              )}

              {/* Intervention plan */}
              {detailAlert.intervention_plan && (
                <div>
                  <h3 className="font-bold text-foreground mb-1">Plán intervence</h3>
                  <p className="text-muted-foreground whitespace-pre-wrap">{detailAlert.intervention_plan}</p>
                </div>
              )}

              {/* Conversation excerpts */}
              {detailAlert.conversation_excerpts && (
                <div>
                  <h3 className="font-bold text-foreground mb-1">Úryvky z konverzace</h3>
                  <div className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">
                    {detailAlert.conversation_excerpts}
                  </div>
                </div>
              )}

              {/* Tasks */}
              {tasks.length > 0 && (
                <div>
                  <h3 className="font-bold text-foreground mb-2">Úkoly</h3>
                  <div className="space-y-2">
                    {tasks.map((t) => (
                      <label key={t.id} className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.status === "DONE"}
                          onChange={() => handleToggleTask(t)}
                          className="mt-0.5 accent-red-600"
                        />
                        <div>
                          <p className={`text-sm font-medium ${t.status === "DONE" ? "line-through opacity-50" : "text-foreground"}`}>{t.title}</p>
                          {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                          <p className="text-xs text-muted-foreground">Pro: {t.assigned_to}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Resolve */}
              {!showResolveInput ? (
                <button
                  onClick={() => setShowResolveInput(true)}
                  className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
                >
                  <CheckCircle className="w-4 h-4" />
                  KRIZE VYŘEŠENA
                </button>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={resolveNotes}
                    onChange={(e) => setResolveNotes(e.target.value)}
                    placeholder="Popište jak byla krize vyřešena (povinné)..."
                    className="w-full border rounded-lg p-3 text-sm min-h-[80px] bg-background text-foreground"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleResolve(detailAlert)}
                      disabled={!resolveNotes.trim()}
                      className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-2 px-4 rounded-lg transition-colors"
                    >
                      Potvrdit vyřešení
                    </button>
                    <button
                      onClick={() => setShowResolveInput(false)}
                      className="px-4 py-2 border rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                    >
                      Zrušit
                    </button>
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
