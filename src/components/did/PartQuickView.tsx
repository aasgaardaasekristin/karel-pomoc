import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface PartQuickViewProps {
  partName: string;
  onClose: () => void;
}

interface QuickViewData {
  registry: any;
  kartoteka: any;
  goals: any[];
  weekMetrics: any[];
  recentThreads: any[];
  alerts: any[];
  switches: any[];
  notes: any[];
}

const PartQuickView = ({ partName, onClose }: PartQuickViewProps) => {
  const [data, setData] = useState<QuickViewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const sb = supabase as any;
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

      const [
        registryRes, kartotekaRes, goalsRes, weekMetricsRes,
        recentThreadsRes, alertsRes, switchesRes, notesRes,
      ] = await Promise.all([
        sb.from("did_part_registry").select("*").eq("part_name", partName).maybeSingle(),
        sb.from("did_kartoteka").select("*").eq("part_name", partName).maybeSingle().then((r: any) => r).catch(() => ({ data: null })),
        sb.from("strategic_goals").select("*").eq("part_name", partName).eq("status", "active").order("created_at", { ascending: false }),
        sb.from("daily_metrics").select("metric_date, emotional_valence, cooperation_level, message_count, switching_count, risk_signals_count").eq("part_name", partName).gte("metric_date", weekAgo).order("metric_date", { ascending: true }),
        sb.from("did_threads").select("id, last_activity_at, sub_mode, messages").eq("part_name", partName).order("last_activity_at", { ascending: false }).limit(3),
        sb.from("safety_alerts").select("id, alert_type, severity, status, created_at, description").eq("part_name", partName).in("status", ["new", "acknowledged"]).order("created_at", { ascending: false }).limit(5),
        sb.from("switching_events").select("id, original_part, detected_part, confidence, created_at").or(`original_part.eq.${partName},detected_part.eq.${partName}`).gte("created_at", today + "T00:00:00").order("created_at", { ascending: false }).limit(5),
        sb.from("therapist_notes").select("id, note_text, note_type, created_at").eq("part_name", partName).order("created_at", { ascending: false }).limit(3),
      ]);

      setData({
        registry: registryRes.data,
        kartoteka: kartotekaRes?.data ?? null,
        goals: goalsRes.data || [],
        weekMetrics: weekMetricsRes.data || [],
        recentThreads: recentThreadsRes.data || [],
        alerts: alertsRes.data || [],
        switches: switchesRes.data || [],
        notes: notesRes.data || [],
      });
      setLoading(false);
    };
    load();
  }, [partName]);

  if (loading) {
    return (
      <div className="p-3 space-y-2 animate-in fade-in duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="animate-pulse rounded-md bg-muted h-4 w-3/4" />
        <div className="animate-pulse rounded-md bg-muted h-16 w-full" />
        <div className="animate-pulse rounded-md bg-muted h-12 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const isEmpty = !data.kartoteka && data.goals.length === 0 && data.weekMetrics.length === 0 && data.alerts.length === 0 && data.notes.length === 0 && data.recentThreads.length === 0;

  return (
    <div
      className="border-t bg-muted/30 rounded-b-md max-h-[400px] overflow-y-auto animate-in slide-in-from-top-2 duration-200"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="p-3 space-y-3">
        {/* HEADER */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold text-foreground">
              {data.registry?.display_name || partName}
            </span>
            {data.registry?.role_in_system && (
              <span className="text-[9px] text-muted-foreground ml-2">
                {data.registry.role_in_system}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* KARTOTÉKA SOUHRN */}
        {data.kartoteka && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
            {data.kartoteka.age_range && (
              <div><span className="text-muted-foreground">Věk:</span> {data.kartoteka.age_range}</div>
            )}
            {data.kartoteka.core_emotion && (
              <div><span className="text-muted-foreground">Jádrová emoce:</span> {data.kartoteka.core_emotion}</div>
            )}
            {data.kartoteka.function_in_system && (
              <div><span className="text-muted-foreground">Funkce:</span> {data.kartoteka.function_in_system}</div>
            )}
            {data.kartoteka.communication_style && (
              <div><span className="text-muted-foreground">Komunikace:</span> {data.kartoteka.communication_style}</div>
            )}
          </div>
        )}

        {/* REGISTRY INFO */}
        {data.registry && (
          <div className="space-y-1 text-[10px]">
            {data.registry.known_strengths && (
              <div>
                <span className="font-medium">💪 Silné stránky</span>
                <p className="text-muted-foreground">{Array.isArray(data.registry.known_strengths) ? data.registry.known_strengths.join(", ") : data.registry.known_strengths}</p>
              </div>
            )}
            {data.registry.known_triggers && (
              <div>
                <span className="font-medium">⚡ Triggery</span>
                <p className="text-muted-foreground">{Array.isArray(data.registry.known_triggers) ? data.registry.known_triggers.join(", ") : data.registry.known_triggers}</p>
              </div>
            )}
          </div>
        )}

        {/* MINI VALENCE SPARKLINE */}
        {data.weekMetrics.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">📊 Valence za týden</span>
            <div className="flex items-end gap-0.5 h-10 mt-1">
              {data.weekMetrics.map((m: any, i: number) => {
                const v = m.emotional_valence;
                const h = v != null ? `${(v / 10) * 100}%` : "10%";
                const color = v == null ? "bg-muted" : v >= 7 ? "bg-green-400" : v >= 4 ? "bg-amber-400" : "bg-red-400";
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end">
                    <div className={cn("w-full rounded-t min-h-[2px]", color)} style={{ height: h }} />
                    <span className="text-[7px] text-muted-foreground">
                      {new Date(m.metric_date + "T12:00:00").toLocaleDateString("cs", { weekday: "narrow" })}
                    </span>
                  </div>
                );
              })}
            </div>
            {data.weekMetrics.some((m: any) => m.cooperation_level != null) && (
              <p className="text-[9px] text-muted-foreground mt-0.5">
                Spolupráce: {data.weekMetrics.filter((m: any) => m.cooperation_level != null).map((m: any) => m.cooperation_level.toFixed(1)).join(" → ")}
              </p>
            )}
          </div>
        )}

        {/* AKTIVNÍ CÍLE */}
        {data.goals.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">🎯 Cíle ({data.goals.length})</span>
            <div className="space-y-1 mt-1">
              {data.goals.slice(0, 3).map((g: any) => (
                <div key={g.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] truncate">{g.goal_text}</p>
                    <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn("h-full rounded-full", (g.progress_pct || 0) >= 75 ? "bg-green-500" : (g.progress_pct || 0) >= 40 ? "bg-amber-500" : "bg-primary")}
                        style={{ width: `${Math.min(g.progress_pct || 0, 100)}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-[9px] text-muted-foreground shrink-0">{g.progress_pct || 0}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AKTIVNÍ ALERTY */}
        {data.alerts.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">⚠️ Alerty ({data.alerts.length})</span>
            <div className="space-y-0.5 mt-1">
              {data.alerts.map((a: any) => (
                <div key={a.id} className="text-[10px]">
                  <span className="font-medium">{a.severity === "critical" ? "🚨" : "⚠️"} {a.alert_type}</span>
                  {a.description && <span className="text-muted-foreground"> — {a.description.slice(0, 100)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* POSLEDNÍ POZNÁMKY */}
        {data.notes.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">📝 Poznámky ({data.notes.length})</span>
            <div className="space-y-0.5 mt-1">
              {data.notes.map((n: any) => (
                <p key={n.id} className="text-[10px] text-muted-foreground">
                  <span className="text-foreground">{new Date(n.created_at).toLocaleDateString("cs")}</span>{" "}
                  {(n.note_text || "").slice(0, 150)}{(n.note_text || "").length > 150 ? "..." : ""}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* DNEŠNÍ SWITCHING */}
        {data.switches.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">🔄 Switching dnes ({data.switches.length})</span>
            <div className="space-y-0.5 mt-1">
              {data.switches.map((s: any) => (
                <p key={s.id} className="text-[10px]">
                  {new Date(s.created_at).toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })} {s.original_part} → {s.detected_part}{" "}
                  <span className="text-muted-foreground">({s.confidence})</span>
                </p>
              ))}
            </div>
          </div>
        )}

        {/* NEDÁVNÉ KONVERZACE */}
        {data.recentThreads.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">💬 Poslední konverzace</span>
            <div className="space-y-0.5 mt-1">
              {data.recentThreads.map((t: any) => {
                const msgs = Array.isArray(t.messages) ? t.messages : [];
                const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
                const preview = lastMsg?.content ? (typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content)).slice(0, 80) : "";
                return (
                  <p key={t.id} className="text-[10px] text-muted-foreground">
                    <span className="text-foreground">{t.last_activity_at ? new Date(t.last_activity_at).toLocaleDateString("cs") : "?"}</span>{" "}
                    {preview}{preview.length >= 80 ? "..." : ""}{" "}
                    <span className="text-[9px]">({msgs.length} zpráv)</span>
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {/* PRÁZDNÝ STAV */}
        {isEmpty && (
          <p className="text-[10px] text-muted-foreground text-center py-2">
            Pro tuto část zatím nejsou žádná podrobná data.
          </p>
        )}
      </div>
    </div>
  );
};

export default PartQuickView;
