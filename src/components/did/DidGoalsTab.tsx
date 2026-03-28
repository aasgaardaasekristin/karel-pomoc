import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const CATEGORY_ICONS: Record<string, string> = {
  therapeutic: "🧠", behavioral: "🎭", emotional: "💛", relational: "🤝",
  safety: "🛡️", integration: "🔗", communication: "💬", daily_life: "🏠",
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "🆕 Navržený", active: "✅ Aktivní", paused: "⏸ Pozastavený",
  completed: "🎉 Splněný", abandoned: "❌ Opuštěný",
};

interface Goal {
  id: string;
  part_name: string;
  goal_text: string;
  description: string | null;
  category: string;
  status: string;
  progress_pct: number;
  milestones: Array<{ text: string; done: boolean }>;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  completed_at: string | null;
  last_evaluated_at: string | null;
  evaluation_notes: string | null;
  priority: string;
  sort_order: number;
  created_at: string;
}

export default function DidGoalsTab() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [parts, setParts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPart, setFilterPart] = useState("__all__");
  const [filterStatus, setFilterStatus] = useState("active");
  const [showForm, setShowForm] = useState(false);

  const [formPart, setFormPart] = useState("");
  const [formText, setFormText] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formCategory, setFormCategory] = useState("therapeutic");
  const [formPriority, setFormPriority] = useState("normal");
  const [saving, setSaving] = useState(false);

  const loadGoals = useCallback(async () => {
    setLoading(true);
    let query = (supabase as any)
      .from("part_goals")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (filterPart !== "__all__") query = query.eq("part_name", filterPart);
    if (filterStatus !== "__all__") query = query.eq("status", filterStatus);

    const [goalsRes, partsRes] = await Promise.all([
      query,
      supabase.from("did_part_registry").select("part_name").eq("status", "active"),
    ]);

    setGoals(goalsRes.data || []);
    setParts((partsRes.data || []).map((p: any) => p.part_name));
    setLoading(false);
  }, [filterPart, filterStatus]);

  useEffect(() => { loadGoals(); }, [loadGoals]);

  const sb = supabase as any;

  async function approveGoal(id: string) {
    await sb.from("part_goals").update({
      status: "active", approved_by: "hanka", approved_at: new Date().toISOString(),
    }).eq("id", id);
    loadGoals();
    toast.success("Cíl schválen");
  }

  async function rejectGoal(id: string) {
    await sb.from("part_goals").update({ status: "abandoned" }).eq("id", id);
    loadGoals();
    toast.success("Cíl odmítnut");
  }

  async function togglePause(id: string, currentStatus: string) {
    await sb.from("part_goals").update({
      status: currentStatus === "paused" ? "active" : "paused",
    }).eq("id", id);
    loadGoals();
  }

  async function completeGoal(id: string) {
    await sb.from("part_goals").update({
      status: "completed", progress_pct: 100, completed_at: new Date().toISOString(),
    }).eq("id", id);
    loadGoals();
    toast.success("🎉 Cíl splněn!");
  }

  async function updateProgress(id: string, pct: number) {
    await sb.from("part_goals").update({ progress_pct: pct }).eq("id", id);
    loadGoals();
  }

  async function handleSaveGoal() {
    if (!formText.trim() || !formPart) return;
    setSaving(true);
    await sb.from("part_goals").insert({
      part_name: formPart, goal_text: formText.trim(),
      description: formDesc.trim() || null, category: formCategory,
      priority: formPriority, status: "active", proposed_by: "hanka",
      approved_by: "hanka", approved_at: new Date().toISOString(),
    });
    setFormText(""); setFormDesc(""); setShowForm(false); setSaving(false);
    loadGoals();
    toast.success("Cíl vytvořen");
  }

  async function deleteGoal(id: string) {
    await sb.from("part_goals").delete().eq("id", id);
    loadGoals();
    toast.success("Smazáno");
  }

  const proposed = goals.filter(g => g.status === "proposed").length;
  const active = goals.filter(g => g.status === "active").length;
  const completed = goals.filter(g => g.status === "completed").length;
  const activeGoals = goals.filter(g => g.status === "active");
  const avgPct = activeGoals.length > 0
    ? Math.round(activeGoals.reduce((s, g) => s + g.progress_pct, 0) / activeGoals.length)
    : 0;

  if (loading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="w-4 h-4 animate-spin" /></div>;
  }

  return (
    <div className="space-y-3">
      {/* Header with filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <Select value={filterPart} onValueChange={setFilterPart}>
          <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Všechny části</SelectItem>
            {parts.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Všechny</SelectItem>
            <SelectItem value="proposed">🆕 Navržené</SelectItem>
            <SelectItem value="active">✅ Aktivní</SelectItem>
            <SelectItem value="paused">⏸ Pozastavené</SelectItem>
            <SelectItem value="completed">🎉 Splněné</SelectItem>
          </SelectContent>
        </Select>

        <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => setShowForm(!showForm)}>
          {showForm ? "✕ Zavřít" : "➕ Nový cíl"}
        </Button>
      </div>

      {/* Stats */}
      <div className="flex gap-3 text-xs text-muted-foreground">
        {proposed > 0 && <span className="text-blue-500 font-medium">🆕 {proposed} ke schválení</span>}
        <span>✅ {active} aktivních</span>
        <span>🎉 {completed} splněných</span>
        <span>∅ pokrok: {avgPct}%</span>
      </div>

      {/* New goal form */}
      {showForm && (
        <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
          <p className="text-xs font-medium">Nový cíl (od terapeutky)</p>
          <Select value={formPart} onValueChange={setFormPart}>
            <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Vyber část" /></SelectTrigger>
            <SelectContent>
              {parts.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={formText} onChange={e => setFormText(e.target.value)} placeholder="Text cíle (stručný, měřitelný)" className="h-7 text-xs" />
          <Textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="Popis / kritéria splnění (volitelné)" className="min-h-[40px] text-xs" />
          <div className="flex gap-2">
            <Select value={formCategory} onValueChange={setFormCategory}>
              <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="therapeutic">🧠 Terapeutický</SelectItem>
                <SelectItem value="behavioral">🎭 Behaviorální</SelectItem>
                <SelectItem value="emotional">💛 Emoční</SelectItem>
                <SelectItem value="relational">🤝 Vztahový</SelectItem>
                <SelectItem value="safety">🛡️ Bezpečnostní</SelectItem>
                <SelectItem value="integration">🔗 Integrační</SelectItem>
                <SelectItem value="communication">💬 Komunikační</SelectItem>
                <SelectItem value="daily_life">🏠 Každodenní</SelectItem>
              </SelectContent>
            </Select>
            <Select value={formPriority} onValueChange={setFormPriority}>
              <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Nízká</SelectItem>
                <SelectItem value="normal">Normální</SelectItem>
                <SelectItem value="high">Vysoká</SelectItem>
                <SelectItem value="critical">Kritická</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" className="h-7 text-xs w-full" onClick={handleSaveGoal} disabled={saving || !formText.trim() || !formPart}>
            💾 Uložit cíl
          </Button>
        </div>
      )}

      {/* Goals list */}
      {goals.map(goal => (
        <div key={goal.id} className={cn(
          "border rounded-lg p-3 space-y-2",
          goal.status === "proposed" && "border-blue-300 bg-blue-50/50 dark:bg-blue-950/20",
          goal.status === "completed" && "border-green-300 bg-green-50/50 dark:bg-green-950/20 opacity-70",
          goal.status === "paused" && "opacity-50",
          goal.priority === "critical" && "border-l-4 border-l-destructive",
          goal.priority === "high" && "border-l-4 border-l-amber-500",
        )}>
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-xs flex-wrap">
                <span>{CATEGORY_ICONS[goal.category] || "🧠"}</span>
                <span className="font-medium text-foreground">{goal.part_name}</span>
                <Badge variant="outline" className="text-[9px] h-4">{STATUS_LABELS[goal.status] || goal.status}</Badge>
                {goal.proposed_by === "karel" && <Badge variant="secondary" className="text-[9px] h-4">🤖 Karel navrhl</Badge>}
              </div>
              <p className="text-sm font-medium mt-1">{goal.goal_text}</p>
              {goal.description && <p className="text-xs text-muted-foreground mt-0.5">{goal.description}</p>}
            </div>
          </div>

          {goal.status !== "completed" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Pokrok</span><span>{goal.progress_pct}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div className={cn("h-2 rounded-full transition-all",
                  goal.progress_pct >= 75 ? "bg-green-500" : goal.progress_pct >= 40 ? "bg-amber-500" : "bg-primary"
                )} style={{ width: `${goal.progress_pct}%` }} />
              </div>
            </div>
          )}

          {goal.evaluation_notes && (
            <p className="text-xs text-muted-foreground italic border-l-2 border-muted pl-2">📝 {goal.evaluation_notes}</p>
          )}

          {Array.isArray(goal.milestones) && goal.milestones.length > 0 && (
            <div className="space-y-0.5">
              {goal.milestones.map((m, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs">
                  <span>{m.done ? "✅" : "⬜"}</span>
                  <span className={m.done ? "line-through text-muted-foreground" : ""}>{m.text}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-1 flex-wrap">
            {goal.status === "proposed" && (
              <>
                <Button size="sm" variant="default" className="h-6 text-[10px] gap-1" onClick={() => approveGoal(goal.id)}>✅ Schválit</Button>
                <Button size="sm" variant="destructive" className="h-6 text-[10px] gap-1" onClick={() => rejectGoal(goal.id)}>❌ Odmítnout</Button>
              </>
            )}
            {goal.status === "active" && (
              <>
                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => updateProgress(goal.id, Math.min(100, goal.progress_pct + 10))}>+10%</Button>
                <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => completeGoal(goal.id)}>🎉 Splněno</Button>
                <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => togglePause(goal.id, goal.status)}>⏸</Button>
              </>
            )}
            {goal.status === "paused" && (
              <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={() => togglePause(goal.id, goal.status)}>▶ Obnovit</Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 text-[10px] text-destructive" onClick={() => deleteGoal(goal.id)}>🗑</Button>
          </div>

          <div className="text-[10px] text-muted-foreground">
            {goal.last_evaluated_at && <span>Hodnoceno: {new Date(goal.last_evaluated_at).toLocaleDateString("cs")}</span>}
            {goal.approved_by && <span className="ml-2">Schválil/a: {goal.approved_by}</span>}
          </div>
        </div>
      ))}

      {goals.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">Žádné cíle pro vybraný filtr.</p>
      )}
    </div>
  );
}
