import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Dispatch {
  id: string;
  report_date: string;
  recipient: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
  retry_count: number;
  last_retry_strategy: string;
  watchdog_log: string;
  cycle_id: string | null;
}

interface Props {
  refreshTrigger?: number;
}

const RECIPIENT_LABELS: Record<string, string> = {
  hanka: "Hanka 🌸",
  kata: "Káťa 🦋",
};

const RECIPIENT_EMAILS: Record<string, string> = {
  hanka: "mujosobniasistentnamiru@gmail.com",
  kata: "K.CC@seznam.cz",
};

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CheckCircle2; label: string }> = {
  sent: { color: "bg-green-500/15 text-green-700 border-green-500/30", icon: CheckCircle2, label: "Odesláno" },
  failed: { color: "bg-destructive/15 text-destructive border-destructive/30", icon: XCircle, label: "Selhalo" },
  pending: { color: "bg-yellow-500/15 text-yellow-700 border-yellow-500/30", icon: Clock, label: "Čeká" },
};

export default function DidReportDiagnostics({ refreshTrigger = 0 }: Props) {
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [aiErrors, setAiErrors] = useState<any[]>([]);

  const fetchData = async () => {
    setLoading(true);
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [dispatchRes, errRes] = await Promise.all([
      supabase
        .from("did_daily_report_dispatches")
        .select("*")
        .gte("report_date", since)
        .order("report_date", { ascending: false }),
      supabase
        .from("ai_error_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    setDispatches((dispatchRes.data as unknown as Dispatch[]) || []);
    setAiErrors((errRes.data as any[]) || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [refreshTrigger]);

  // Stats
  const last7days = dispatches.filter(d => {
    const diff = Date.now() - new Date(d.report_date).getTime();
    return diff < 7 * 24 * 60 * 60 * 1000;
  });
  const sentCount = last7days.filter(d => d.status === "sent").length;
  const failedCount = last7days.filter(d => d.status === "failed").length;
  const retriedCount = last7days.filter(d => d.retry_count > 0).length;

  // Group by date
  const byDate: Record<string, Dispatch[]> = {};
  for (const d of dispatches) {
    (byDate[d.report_date] ||= []).push(d);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Odesláno (7d)" value={sentCount} icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-600" />} />
        <StatCard label="Selhání (7d)" value={failedCount} icon={<XCircle className="w-3.5 h-3.5 text-destructive" />} />
        <StatCard label="Retry (7d)" value={retriedCount} icon={<RefreshCw className="w-3.5 h-3.5 text-primary" />} />
      </div>

      {/* Target emails */}
      <div className="rounded-lg border border-border p-2.5 bg-muted/30">
        <p className="text-[0.625rem] font-medium text-muted-foreground mb-1.5">Cílové adresy</p>
        <div className="space-y-1">
          {Object.entries(RECIPIENT_EMAILS).map(([key, email]) => (
            <div key={key} className="flex items-center justify-between text-[0.625rem]">
              <span className="text-foreground">{RECIPIENT_LABELS[key]}</span>
              <span className="text-muted-foreground font-mono">{email}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Dispatch table by date */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-foreground">Historie (14 dní)</p>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[0.625rem]" onClick={fetchData}>
            <RefreshCw className="w-3 h-3 mr-1" /> Obnovit
          </Button>
        </div>

        {Object.keys(byDate).length === 0 ? (
          <p className="text-[0.625rem] text-muted-foreground text-center py-4">Žádné záznamy</p>
        ) : (
          Object.entries(byDate).map(([date, items]) => (
            <div key={date} className="rounded-lg border border-border overflow-hidden">
              <div className="bg-muted/50 px-2.5 py-1.5 text-[0.625rem] font-medium text-foreground">
                {new Date(date + "T00:00:00").toLocaleDateString("cs-CZ", { weekday: "short", day: "numeric", month: "short" })}
              </div>
              <div className="divide-y divide-border">
                {items.map(d => {
                  const cfg = STATUS_CONFIG[d.status] || STATUS_CONFIG.pending;
                  const Icon = cfg.icon;
                  const isExpanded = expandedRow === d.id;

                  return (
                    <div key={d.id}>
                      <button
                        onClick={() => setExpandedRow(isExpanded ? null : d.id)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/30 transition-colors"
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-[0.625rem] text-foreground flex-1">
                          {RECIPIENT_LABELS[d.recipient] || d.recipient}
                        </span>
                        <Badge variant="outline" className={`text-[8px] h-4 px-1.5 ${cfg.color}`}>
                          {cfg.label}
                        </Badge>
                        {d.retry_count > 0 && (
                          <Badge variant="secondary" className="text-[0.5rem] h-4 px-1.5">
                            {d.retry_count}× retry
                          </Badge>
                        )}
                        {d.sent_at && (
                          <span className="text-[0.5625rem] text-muted-foreground">
                            {new Date(d.sent_at).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="px-2.5 pb-2 space-y-1.5 bg-muted/20">
                          {d.error_message && (
                            <div className="rounded border border-destructive/20 bg-destructive/5 p-2">
                              <p className="text-[0.5625rem] font-medium text-destructive flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Chyba
                              </p>
                              <p className="text-[0.5625rem] text-muted-foreground mt-0.5 break-all">{d.error_message}</p>
                            </div>
                          )}
                          {d.last_retry_strategy && (
                            <div className="text-[0.5625rem] text-muted-foreground">
                              <span className="font-medium text-foreground">Strategie:</span> {d.last_retry_strategy}
                            </div>
                          )}
                          {d.watchdog_log && (
                            <div className="rounded border border-border bg-background p-2">
                              <p className="text-[0.5625rem] font-medium text-foreground mb-0.5">Watchdog log</p>
                              <pre className="text-[0.5rem] text-muted-foreground whitespace-pre-wrap break-all font-mono">{d.watchdog_log}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-2 text-center">
      <div className="flex items-center justify-center gap-1 mb-0.5">{icon}</div>
      <p className="text-lg font-bold text-foreground">{value}</p>
      <p className="text-[0.5625rem] text-muted-foreground">{label}</p>
    </div>
  );
}
