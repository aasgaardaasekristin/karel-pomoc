import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

interface DailyMetric {
  id: string;
  metric_date: string;
  part_name: string | null;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  avg_message_length: number;
  session_count: number;
  emotional_valence: number | null;
  emotional_arousal: number | null;
  cooperation_level: number | null;
  openness_level: number | null;
  switching_count: number;
  risk_signals_count: number;
  positive_signals_count: number;
  promises_made: number;
  promises_fulfilled: number;
  unresolved_topics: number;
  new_topics_introduced: number;
  therapist_notes_count: number;
}

function trendArrow(metrics: DailyMetric[], key: keyof DailyMetric): { arrow: string; color: string } {
  if (metrics.length < 6) return { arrow: "→", color: "text-muted-foreground" };
  const recent = metrics.slice(-3);
  const previous = metrics.slice(-6, -3);
  const avg = (arr: DailyMetric[]) => arr.reduce((s, m) => s + (Number(m[key]) || 0), 0) / arr.length;
  const diff = avg(recent) - avg(previous);
  const threshold = Math.max(avg(previous) * 0.1, 0.5);
  if (diff > threshold) return { arrow: "↑", color: "text-emerald-500" };
  if (diff < -threshold) return { arrow: "↓", color: "text-red-500" };
  return { arrow: "→", color: "text-muted-foreground" };
}

function valenceColor(v: number | null): string {
  if (v == null) return "bg-muted";
  if (v < 4) return "bg-red-400";
  if (v <= 6) return "bg-amber-400";
  return "bg-emerald-400";
}

const DidTrendsTab = () => {
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [parts, setParts] = useState<string[]>([]);
  const [selectedPart, setSelectedPart] = useState("all");
  const [period, setPeriod] = useState(7);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from("did_part_registry").select("part_name").eq("status", "active")
      .then(({ data }) => setParts((data || []).map((p: any) => p.part_name)));
  }, []);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);
    let query = supabase
      .from("daily_metrics")
      .select("*")
      .gte("metric_date", since)
      .order("metric_date", { ascending: true });

    if (selectedPart !== "all") {
      query = query.eq("part_name", selectedPart);
    } else {
      query = query.is("part_name", null);
    }

    const { data } = await query;
    setMetrics((data as DailyMetric[]) || []);
    setLoading(false);
  }, [selectedPart, period]);

  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  const sum = (key: keyof DailyMetric) => metrics.reduce((s, m) => s + (Number(m[key]) || 0), 0);
  const avg = (key: keyof DailyMetric) => {
    const vals = metrics.filter(m => m[key] != null).map(m => Number(m[key]));
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "—";
  };

  const maxMessages = Math.max(...metrics.map(m => m.message_count), 1);
  const maxValence = 10;

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-2">
        <select
          value={selectedPart}
          onChange={e => setSelectedPart(e.target.value)}
          className="text-xs border rounded px-2 py-1 bg-background text-foreground"
        >
          <option value="all">Celý systém</option>
          {parts.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={period}
          onChange={e => setPeriod(Number(e.target.value))}
          className="text-xs border rounded px-2 py-1 bg-background text-foreground"
        >
          <option value={7}>7 dní</option>
          <option value={14}>14 dní</option>
          <option value={30}>30 dní</option>
        </select>
      </div>

      {metrics.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">Žádné metriky za vybrané období.</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-3 rounded-lg border bg-card">
              <p className="text-[10px] text-muted-foreground mb-1">💬 Aktivita</p>
              <p className="text-lg font-bold text-foreground">{sum("message_count")}</p>
              <p className="text-[10px] text-muted-foreground">zpráv · {sum("session_count")} sezení</p>
              <p className="text-[10px] text-muted-foreground">∅ {metrics.length > 0 ? Math.round(sum("message_count") / metrics.length) : 0} zpráv/den</p>
            </div>

            <div className="p-3 rounded-lg border bg-card">
              <p className="text-[10px] text-muted-foreground mb-1">😊 Emoční stav</p>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold text-foreground">{avg("emotional_valence")}</span>
                <span className="text-[10px] text-muted-foreground">/10</span>
                <span className={`text-sm ${trendArrow(metrics, "emotional_valence").color}`}>
                  {trendArrow(metrics, "emotional_valence").arrow}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                spolupráce: {avg("cooperation_level")} <span className={trendArrow(metrics, "cooperation_level").color}>{trendArrow(metrics, "cooperation_level").arrow}</span>
                {" · "}otevřenost: {avg("openness_level")}
              </p>
            </div>

            <div className="p-3 rounded-lg border bg-card">
              <p className="text-[10px] text-muted-foreground mb-1">⚠️ Bezpečnost</p>
              <p className="text-lg font-bold text-foreground">{sum("switching_count")}</p>
              <p className="text-[10px] text-muted-foreground">switchingů</p>
              <p className="text-[10px]">
                <span className="text-red-500">{sum("risk_signals_count")} rizik</span>
                {" · "}
                <span className="text-emerald-500">{sum("positive_signals_count")} pozitiv</span>
              </p>
            </div>

            <div className="p-3 rounded-lg border bg-card">
              <p className="text-[10px] text-muted-foreground mb-1">🤝 Terapie</p>
              <p className="text-lg font-bold text-foreground">{sum("promises_made")}/{sum("promises_fulfilled")}</p>
              <p className="text-[10px] text-muted-foreground">slibů dáno/splněno</p>
              <p className="text-[10px] text-muted-foreground">
                {sum("unresolved_topics")} nedořešených · {sum("therapist_notes_count")} poznámek
              </p>
            </div>
          </div>

          {/* Activity bar chart */}
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">💬 Zprávy / den</p>
            {metrics.map(m => (
              <div key={m.metric_date} className="flex items-center gap-2 text-[10px]">
                <span className="w-10 text-right text-muted-foreground shrink-0">
                  {new Date(m.metric_date).toLocaleDateString("cs", { day: "numeric", month: "numeric" })}
                </span>
                <div className="flex-1 h-4 bg-muted rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-primary/60 rounded-sm transition-all"
                    style={{ width: `${(m.message_count / maxMessages) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-right text-foreground shrink-0">{m.message_count}</span>
              </div>
            ))}
          </div>

          {/* Emotional valence bar chart */}
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">😊 Emoční valence / den</p>
            {metrics.filter(m => m.emotional_valence != null).map(m => (
              <div key={m.metric_date + "-val"} className="flex items-center gap-2 text-[10px]">
                <span className="w-10 text-right text-muted-foreground shrink-0">
                  {new Date(m.metric_date).toLocaleDateString("cs", { day: "numeric", month: "numeric" })}
                </span>
                <div className="flex-1 h-4 bg-muted rounded-sm overflow-hidden">
                  <div
                    className={`h-full rounded-sm transition-all ${valenceColor(m.emotional_valence)}`}
                    style={{ width: `${((m.emotional_valence || 0) / maxValence) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-right text-foreground shrink-0">{m.emotional_valence?.toFixed(1)}</span>
              </div>
            ))}
          </div>

          {/* Detail table */}
          <details className="mt-2">
            <summary className="text-[10px] font-medium cursor-pointer text-muted-foreground">📊 Detailní data</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-1">Datum</th>
                    <th className="text-right p-1">Zprávy</th>
                    <th className="text-right p-1">Sezení</th>
                    <th className="text-right p-1">Valence</th>
                    <th className="text-right p-1">Spolupr.</th>
                    <th className="text-right p-1">Switch</th>
                    <th className="text-right p-1">Rizika</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(m => (
                    <tr key={m.metric_date} className="border-b border-muted">
                      <td className="p-1">{new Date(m.metric_date).toLocaleDateString("cs", { day: "numeric", month: "numeric" })}</td>
                      <td className="text-right p-1">{m.message_count}</td>
                      <td className="text-right p-1">{m.session_count}</td>
                      <td className="text-right p-1">{m.emotional_valence?.toFixed(1) ?? "—"}</td>
                      <td className="text-right p-1">{m.cooperation_level?.toFixed(1) ?? "—"}</td>
                      <td className="text-right p-1">{m.switching_count}</td>
                      <td className="text-right p-1">{m.risk_signals_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
};

export default DidTrendsTab;
