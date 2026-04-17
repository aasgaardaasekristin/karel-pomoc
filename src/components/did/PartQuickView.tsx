import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { X, Pencil, RotateCcw } from "lucide-react";
import RichMarkdown from "@/components/ui/RichMarkdown";
import { OPEN_PHASE_FILTER } from "@/lib/canonicalSnapshot";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";

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
  isInCrisis: boolean;
  partState: string | null;
}

const STATE_OPTIONS = [
  { value: "crisis", emoji: "🔴", label: "KRIZE" },
  { value: "unstable", emoji: "🟠", label: "NESTABILNÍ" },
  { value: "stabilizing", emoji: "🟡", label: "STABILIZUJE SE" },
  { value: "stable", emoji: "🟢", label: "STABILNÍ" },
  { value: "progressing", emoji: "🔵", label: "PROGREDUJE" },
  { value: "integrating", emoji: "🟣", label: "INTEGRACE" },
];

const PartQuickView = ({ partName, onClose }: PartQuickViewProps) => {
  const [data, setData] = useState<QuickViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showStateEditor, setShowStateEditor] = useState(false);
  const [manualOverride, setManualOverride] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const sb = supabase as any;
      // FÁZE 3B: Prague-day, sjednoceno s ostatními callsites.
      const today = pragueTodayISO();
      const weekAgo = pragueTodayISO(new Date(Date.now() - 7 * 86400000));

      const [
        registryRes, kartotekaRes, goalsRes, weekMetricsRes,
        recentThreadsRes, alertsRes, switchesRes, notesRes, crisisRes,
      ] = await Promise.all([
        sb.from("did_part_registry").select("*").eq("part_name", partName).maybeSingle(),
        sb.from("did_kartoteka").select("*").eq("part_name", partName).maybeSingle().then((r: any) => r).catch(() => ({ data: null })),
        sb.from("strategic_goals").select("*").eq("part_name", partName).in("status", ["active", "proposed", "paused"]).order("created_at", { ascending: false }),
        sb.from("daily_metrics").select("metric_date, emotional_valence, cooperation_level, message_count, switching_count, risk_signals_count").eq("part_name", partName).gte("metric_date", weekAgo).order("metric_date", { ascending: true }),
        sb.from("did_threads").select("id, last_activity_at, sub_mode, messages").eq("part_name", partName).order("last_activity_at", { ascending: false }).limit(3),
        sb.from("safety_alerts").select("id, alert_type, severity, status, created_at, description").eq("part_name", partName).in("status", ["new", "acknowledged"]).order("created_at", { ascending: false }).limit(5),
        sb.from("switching_events").select("id, original_part, detected_part, confidence, created_at").or(`original_part.eq.${partName},detected_part.eq.${partName}`).gte("created_at", today + "T00:00:00").order("created_at", { ascending: false }).limit(5),
        sb.from("therapist_notes").select("id, note_text, note_type, created_at").eq("part_name", partName).order("created_at", { ascending: false }).limit(3),
        // FÁZE 3B: kanonický open-phase filter — sjednoceno s canonicalCrisis / canonicalSnapshot.
        sb.from("crisis_events").select("part_name, phase")
          .eq("part_name", partName)
          .not("phase", "in", `(${OPEN_PHASE_FILTER.map((p) => `"${p}"`).join(",")})`)
          .limit(1),
      ]);

      const reg = registryRes.data;
      setManualOverride(reg?.manual_state_override || null);

      // Determine part state from metrics trend (or manual override)
      const wm = weekMetricsRes.data || [];
      const crisisActive = (crisisRes.data || []).length > 0;
      let partState: string | null = null;

      if (reg?.manual_state_override) {
        partState = reg.manual_state_override;
      } else if (crisisActive) {
        partState = "crisis";
      } else {
        const vals = wm.filter((m: any) => m.emotional_valence != null).map((m: any) => m.emotional_valence);
        if (vals.length >= 3) {
          const firstHalf = vals.slice(0, Math.floor(vals.length / 2));
          const secondHalf = vals.slice(Math.floor(vals.length / 2));
          const avgF = firstHalf.reduce((a: number, b: number) => a + b, 0) / firstHalf.length;
          const avgS = secondHalf.reduce((a: number, b: number) => a + b, 0) / secondHalf.length;
          if (avgS < avgF - 0.5) partState = "unstable";
          else if (avgS > avgF + 0.5) partState = "progressing";
          else partState = "stable";
        } else {
          partState = "stable";
        }
      }

      setData({
        registry: reg,
        kartoteka: kartotekaRes?.data ?? null,
        goals: goalsRes.data || [],
        weekMetrics: wm,
        recentThreads: recentThreadsRes.data || [],
        alerts: alertsRes.data || [],
        switches: switchesRes.data || [],
        notes: notesRes.data || [],
        isInCrisis: crisisActive,
        partState,
      });
      setLoading(false);
    };
    load();
  }, [partName]);

  const handleSetManualState = async (state: string) => {
    setSaving(true);
    const sb = supabase as any;
    await sb.from("did_part_registry")
      .update({ manual_state_override: state, updated_at: new Date().toISOString() })
      .eq("part_name", partName);
    setManualOverride(state);
    if (data) {
      setData({ ...data, partState: state });
    }
    setShowStateEditor(false);
    setSaving(false);
  };

  const handleResetToAuto = async () => {
    setSaving(true);
    const sb = supabase as any;
    await sb.from("did_part_registry")
      .update({ manual_state_override: null, updated_at: new Date().toISOString() })
      .eq("part_name", partName);
    setManualOverride(null);
    setShowStateEditor(false);
    setSaving(false);
    // Reload to recalculate auto state
    window.location.reload();
  };

  if (loading) {
    return (
      <div className="p-3 space-y-2 animate-in fade-in duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="animate-pulse rounded-md bg-muted h-4 w-3/4" />
        <div className="animate-pulse rounded-md bg-muted h-16 w-full" />
        <div className="animate-pulse rounded-md bg-muted h-12 w-full" />
      </div>
    );
  }
  const stateConfig: Record<string, { emoji: string; label: string; className: string }> = {
    crisis:      { emoji: "🔴", label: "KRIZE",          className: "bg-destructive/20 text-destructive border-destructive/30" },
    unstable:    { emoji: "🟠", label: "NESTABILNÍ",     className: "bg-orange-500/20 text-orange-700 dark:text-orange-400 border-orange-500/30" },
    stabilizing: { emoji: "🟡", label: "STABILIZUJE SE", className: "bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30" },
    stable:      { emoji: "🟢", label: "STABILNÍ",       className: "bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30" },
    progressing: { emoji: "🔵", label: "PROGREDUJE",     className: "bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30" },
    integrating: { emoji: "🟣", label: "INTEGRACE",      className: "bg-purple-500/20 text-purple-700 dark:text-purple-400 border-purple-500/30" },
  };

  const goalTypeBadge: Record<string, { label: string; className: string }> = {
    safety:        { label: "Safety",        className: "bg-destructive/20 text-destructive" },
    stabilization: { label: "Stabilizace",   className: "bg-orange-500/20 text-orange-700 dark:text-orange-400" },
    consolidation: { label: "Upevnění",      className: "bg-amber-500/20 text-amber-700 dark:text-amber-400" },
    development:   { label: "Rozvoj",        className: "bg-green-500/20 text-green-700 dark:text-green-400" },
    integration:   { label: "Integrace",     className: "bg-purple-500/20 text-purple-700 dark:text-purple-400" },
  };

  if (!data) return null;

  const isEmpty = !data.kartoteka && data.goals.length === 0 && data.weekMetrics.length === 0 && data.alerts.length === 0 && data.notes.length === 0 && data.recentThreads.length === 0 && !data.registry?.next_session_plan;
  const sc = data.partState ? stateConfig[data.partState] : null;

  return (
    <div
      className="border-t bg-muted/30 rounded-b-md max-h-[400px] overflow-y-auto animate-in slide-in-from-top-2 duration-200"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="p-3 space-y-3">
        {/* HEADER */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">
              {data.registry?.display_name || partName}
            </span>
            {sc && (
              <span className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1", sc.className)}>
                {sc.emoji} {sc.label}
                {manualOverride && (
                  <span className="text-[8px] opacity-70">(manuální)</span>
                )}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0"
              onClick={() => setShowStateEditor(!showStateEditor)}
              title="Změnit stav části"
            >
              <Pencil className="w-3 h-3" />
            </Button>
            {data.registry?.role_in_system && (
              <span className="text-[9px] text-muted-foreground">
                {data.registry.role_in_system}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* STATE EDITOR DROPDOWN */}
        {showStateEditor && (
          <div className="flex flex-wrap gap-1 p-2 rounded-md border bg-background">
            {STATE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                variant={data.partState === opt.value ? "default" : "outline"}
                size="sm"
                className="h-6 text-[10px] px-2"
                disabled={saving}
                onClick={() => handleSetManualState(opt.value)}
              >
                {opt.emoji} {opt.label}
              </Button>
            ))}
            {manualOverride && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2 gap-1"
                disabled={saving}
                onClick={handleResetToAuto}
              >
                <RotateCcw className="w-3 h-3" /> Auto
              </Button>
            )}
          </div>
        )}

        {/* 📋 KONTEXTOVÝ HINT (legacy next_session_plan) — NENÍ source-of-truth dnešního sezení.
            FÁZE 3: dnešní sezení žije v did_daily_session_plans. Toto je jen kontext k části. */}
        {data.registry?.next_session_plan && (
          <div className={cn(
            "rounded-md border p-2.5 opacity-90",
            data.isInCrisis ? "border-destructive/40 bg-destructive/5" : "border-muted bg-muted/30"
          )}>
            <span className={cn(
              "text-[11px] font-semibold",
              data.isInCrisis ? "text-destructive" : "text-muted-foreground"
            )}>
              📋 Kontext k části (hint, ne dnešní plán)
            </span>
            <div className="mt-1.5 text-[10px] leading-relaxed text-foreground prose-sm max-w-none">
              <RichMarkdown compact>{data.registry.next_session_plan}</RichMarkdown>
            </div>
            <div className="mt-1 text-[9px] text-muted-foreground/70 italic">
              Dnešní plán sezení: viz hlavní dashboard (Karlův denní plán).
            </div>
          </div>
        )}

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

        {/* CÍLE */}
        {data.goals.length > 0 && (
          <div>
            <span className="text-[10px] font-medium">🎯 Cíle ({data.goals.length})</span>
            <div className="space-y-1.5 mt-1">
              {data.goals.slice(0, 5).map((g: any) => {
                const isPaused = g.status === "paused";
                const gtBadge = g.goal_type ? goalTypeBadge[g.goal_type] : null;
                const stateChanged = g.state_at_creation && data.partState && g.state_at_creation !== data.partState;
                return (
                  <div key={g.id} className={cn("flex items-center gap-2", isPaused && "opacity-50")}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <p className={cn("text-[10px] truncate", isPaused && "line-through")}>{g.goal_text}</p>
                        {gtBadge && (
                          <span className={cn("text-[7px] px-1 py-0.5 rounded shrink-0", gtBadge.className)}>
                            {gtBadge.label}
                          </span>
                        )}
                        {stateChanged && <span title={`Vytvořeno ve stavu: ${g.state_at_creation}`}>⚡</span>}
                      </div>
                      {isPaused ? (
                        <p className="text-[9px] text-muted-foreground">⏸ Pozastaveno: {g.pause_reason || "změna stavu"}</p>
                      ) : (
                        <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn("h-full rounded-full", (g.progress_pct || 0) >= 75 ? "bg-green-500" : (g.progress_pct || 0) >= 40 ? "bg-amber-500" : "bg-primary")}
                            style={{ width: `${Math.min(g.progress_pct || 0, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    {!isPaused && <span className="text-[9px] text-muted-foreground shrink-0">{g.progress_pct || 0}%</span>}
                  </div>
                );
              })}
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