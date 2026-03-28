import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Loader2, RefreshCw, CheckCircle, SkipForward, FileText, BarChart3 } from "lucide-react";

type PlannedSession = {
  id: string;
  part_name: string;
  therapist: string;
  method_name: string;
  priority: string;
  status: string;
  horizon: string;
  description: string | null;
  expected_outcome: string | null;
  actual_outcome: string | null;
  scheduled_date: string | null;
  completed_date: string | null;
  notes: string | null;
};

type StrategicGoal = {
  id: string;
  part_name: string | null;
  goal_text: string;
  category: string | null;
  status: string;
  progress_pct: number;
  evidence: string[];
};

type PlanLog = {
  id: string;
  plan_type: string;
  parts_included: string[];
  sessions_planned: number;
  sessions_completed: number;
  goals_updated: number;
  processing_time_ms: number | null;
  error: string | null;
  created_at: string;
};

const priorityOrder = { urgent: 0, soon: 1, normal: 2, when_ready: 3 };
const priorityColors: Record<string, string> = {
  urgent: "bg-destructive text-destructive-foreground",
  soon: "bg-amber-500/20 text-amber-700",
  normal: "bg-primary/10 text-primary",
  when_ready: "bg-muted text-muted-foreground",
};

export default function DidPlanTab() {
  const [sessions, setSessions] = useState<PlannedSession[]>([]);
  const [goals, setGoals] = useState<StrategicGoal[]>([]);
  const [logs, setLogs] = useState<PlanLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"plan" | "goals" | "review" | "stats">("plan");

  async function load() {
    setLoading(true);
    const [sessRes, goalsRes, logsRes] = await Promise.all([
      supabase.from("planned_sessions").select("*").in("status", ["planned", "scheduled", "done", "skipped"]).order("created_at", { ascending: false }).limit(50),
      supabase.from("strategic_goals").select("*").order("progress_pct", { ascending: false }).limit(50),
      supabase.from("plan_update_log").select("*").order("created_at", { ascending: false }).limit(20),
    ]);
    setSessions((sessRes.data as any[]) || []);
    setGoals((goalsRes.data as any[]) || []);
    setLogs((logsRes.data as any[]) || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function callFunction(name: string, label: string) {
    setUpdating(name);
    try {
      const { data, error } = await supabase.functions.invoke(name, { body: { source: "manual" } });
      if (error) throw error;
      toast.success(`${label} dokončeno`, { description: JSON.stringify(data).slice(0, 100) });
      load();
    } catch (e: any) {
      toast.error(`${label} selhalo`, { description: e.message });
    } finally {
      setUpdating(null);
    }
  }

  async function markSession(id: string, status: "done" | "skipped") {
    await supabase.from("planned_sessions").update({
      status,
      [status === "done" ? "completed_date" : "updated_at"]: new Date().toISOString().slice(0, 10),
    }).eq("id", id);
    toast.success(status === "done" ? "Splněno ✅" : "Přeskočeno ⏭");
    load();
  }

  const activeSessions = sessions.filter(s => s.status === "planned" || s.status === "scheduled")
    .sort((a, b) => (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 3) - (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 3));
  const doneSessions = sessions.filter(s => s.status === "done" || s.status === "skipped");
  const activeGoals = goals.filter(g => g.status === "active");
  const avgProgress = activeGoals.length ? Math.round(activeGoals.reduce((s, g) => s + g.progress_pct, 0) / activeGoals.length) : 0;

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-3">
      {/* Sub-tabs */}
      <div className="flex gap-1 p-0.5 rounded-md bg-muted/50">
        {([
          { key: "plan" as const, label: "📅 Plán", icon: null },
          { key: "goals" as const, label: "🎯 Cíle", icon: null },
          { key: "review" as const, label: "📋 Review", icon: null },
          { key: "stats" as const, label: "📊 Stats", icon: null },
        ]).map(t => (
          <button key={t.key} onClick={() => setSubTab(t.key)}
            className={`flex-1 text-[10px] py-1 rounded transition-colors ${subTab === t.key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── PLAN TAB ── */}
      {subTab === "plan" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-[10px] gap-1" disabled={!!updating} onClick={() => callFunction("update-operative-plan", "Aktualizace plánu")}>
              {updating === "update-operative-plan" ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Aktualizovat plán
            </Button>
          </div>

          {activeSessions.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">Žádná naplánovaná sezení</p>}

          {activeSessions.map(s => (
            <div key={s.id} className="p-2 rounded-md border text-xs space-y-1">
              <div className="flex items-center gap-2">
                <Badge className={`text-[9px] px-1.5 py-0 ${priorityColors[s.priority] || ""}`}>{s.priority}</Badge>
                <span className="font-medium text-foreground">{s.part_name}</span>
                <span className="text-muted-foreground">—</span>
                <span>{s.method_name}</span>
                <Badge variant="outline" className="text-[9px] ml-auto">{s.therapist}</Badge>
              </div>
              {s.description && <p className="text-[10px] text-muted-foreground">{s.description}</p>}
              <div className="flex gap-1 pt-1">
                <Button size="sm" variant="ghost" className="h-5 text-[9px] gap-0.5 px-1.5" onClick={() => markSession(s.id, "done")}>
                  <CheckCircle className="w-3 h-3 text-emerald-600" /> Splněno
                </Button>
                <Button size="sm" variant="ghost" className="h-5 text-[9px] gap-0.5 px-1.5" onClick={() => markSession(s.id, "skipped")}>
                  <SkipForward className="w-3 h-3 text-amber-600" /> Přeskočeno
                </Button>
              </div>
            </div>
          ))}

          {doneSessions.length > 0 && (
            <details className="text-xs">
              <summary className="text-muted-foreground cursor-pointer py-1">Dokončená sezení ({doneSessions.length})</summary>
              {doneSessions.slice(0, 10).map(s => (
                <div key={s.id} className="flex items-center gap-2 py-0.5 text-[10px] text-muted-foreground">
                  <span>{s.status === "done" ? "✅" : "⏭"}</span>
                  <span>{s.part_name} — {s.method_name}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {/* ── GOALS TAB ── */}
      {subTab === "goals" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-[10px] gap-1" disabled={!!updating} onClick={() => callFunction("update-strategic-outlook", "Strategický výhled")}>
              {updating === "update-strategic-outlook" ? <Loader2 className="w-3 h-3 animate-spin" /> : <BarChart3 className="w-3 h-3" />}
              Aktualizovat výhled
            </Button>
          </div>

          {activeGoals.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">Žádné aktivní cíle</p>}

          {activeGoals.map(g => (
            <div key={g.id} className="p-2 rounded-md border text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">{g.part_name || "Systém"}</span>
                {g.category && <Badge variant="secondary" className="text-[9px]">{g.category}</Badge>}
              </div>
              <p className="text-[10px]">{g.goal_text}</p>
              <div className="flex items-center gap-2">
                <Progress value={g.progress_pct} className="h-1.5 flex-1" />
                <span className="text-[10px] text-muted-foreground font-mono">{g.progress_pct}%</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── REVIEW TAB ── */}
      {subTab === "review" && (
        <div className="space-y-2">
          <Button size="sm" className="h-7 text-[10px] gap-1" disabled={!!updating} onClick={() => callFunction("generate-weekly-review", "Týdenní review")}>
            {updating === "generate-weekly-review" ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
            Generovat týdenní review
          </Button>

          {logs.filter(l => l.plan_type === "weekly_review").slice(0, 5).map(l => (
            <div key={l.id} className="p-2 rounded-md border text-[10px]">
              <div className="flex justify-between">
                <span>{new Date(l.created_at).toLocaleDateString("cs")}</span>
                <span className="text-muted-foreground">{l.processing_time_ms ? `${(l.processing_time_ms / 1000).toFixed(1)}s` : ""}</span>
              </div>
              {l.error && <p className="text-destructive mt-1">{l.error}</p>}
              {!l.error && <p className="text-muted-foreground">Sezení dokončeno: {l.sessions_completed}, Cíle: {l.goals_updated}</p>}
            </div>
          ))}
        </div>
      )}

      {/* ── STATS TAB ── */}
      {subTab === "stats" && (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <StatCard label="Naplánováno" value={activeSessions.length} />
            <StatCard label="Dokončeno" value={doneSessions.filter(s => s.status === "done").length} />
            <StatCard label="Přeskočeno" value={doneSessions.filter(s => s.status === "skipped").length} />
            <StatCard label="Ø pokrok cílů" value={`${avgProgress}%`} />
          </div>

          <p className="text-[10px] text-muted-foreground font-medium pt-2">Poslední aktualizace</p>
          {logs.slice(0, 10).map(l => (
            <div key={l.id} className="flex items-center gap-2 text-[10px] py-0.5">
              <Badge variant="outline" className="text-[8px]">{l.plan_type}</Badge>
              <span>{new Date(l.created_at).toLocaleDateString("cs")}</span>
              <span className="text-muted-foreground ml-auto">{l.processing_time_ms ? `${(l.processing_time_ms / 1000).toFixed(1)}s` : ""}</span>
              {l.error && <span className="text-destructive">❌</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-2 rounded-md border text-center">
      <div className="text-lg font-bold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
