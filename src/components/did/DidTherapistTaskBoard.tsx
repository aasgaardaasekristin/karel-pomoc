import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, MessageSquare, ChevronDown, ChevronUp, Send, Trash2, ExternalLink, ArrowUp } from "lucide-react";
import { toast } from "sonner";

interface TherapistTask {
  id: string;
  task: string;
  assigned_to: string;
  status: string;
  note: string;
  completed_note: string;
  source_agreement: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  due_date: string | null;
  priority: string;
  category: string;
  status_hanka: string;
  status_kata: string;
}

type TrafficStatus = "not_started" | "in_progress" | "done";

const TRAFFIC_COLORS: Record<TrafficStatus, string> = {
  not_started: "bg-destructive",
  in_progress: "bg-orange-400",
  done: "bg-green-500",
};

const NEXT_STATUS: Record<TrafficStatus, TrafficStatus> = {
  not_started: "in_progress",
  in_progress: "done",
  done: "not_started",
};

const STATUS_LABEL: Record<TrafficStatus, string> = {
  not_started: "Nezapočato",
  in_progress: "Rozpracováno",
  done: "Splněno",
};

const MAX_TODAY = 5;
const MAX_TOMORROW = 5;
const MAX_LONGTERM = 10;

const TrafficLight = ({ status, label, onClick }: { status: TrafficStatus; label: string; onClick: () => void }) => (
  <button onClick={onClick} className="flex items-center gap-1 group cursor-pointer" title={`${label}: ${STATUS_LABEL[status]}`}>
    <span className={`w-2.5 h-2.5 rounded-full ${TRAFFIC_COLORS[status]} shadow-sm transition-all duration-200 group-hover:scale-150 group-hover:shadow-md`} />
    <span className="text-[8px] font-medium text-muted-foreground opacity-70">{label}</span>
  </button>
);

const isAllDone = (task: TherapistTask) => {
  if (task.assigned_to === "hanka") return task.status_hanka === "done";
  if (task.assigned_to === "kata") return task.status_kata === "done";
  return task.status_hanka === "done" && task.status_kata === "done";
};

// ── Task Card (shared for today/tomorrow) ──
const TaskCard = ({
  task,
  expandedTask,
  setExpandedTask,
  noteInputs,
  setNoteInputs,
  onToggleTraffic,
  onDelete,
  onAddNote,
  extraActions,
}: {
  task: TherapistTask;
  expandedTask: string | null;
  setExpandedTask: (id: string | null) => void;
  noteInputs: Record<string, string>;
  setNoteInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onToggleTraffic: (task: TherapistTask, who: "hanka" | "kata") => void;
  onDelete: (id: string) => void;
  onAddNote: (id: string) => void;
  extraActions?: React.ReactNode;
}) => {
  const isExpanded = expandedTask === task.id;
  const driveLink = task.source_agreement?.startsWith("http")
    ? task.source_agreement
    : task.source_agreement
    ? `https://drive.google.com/drive/search?q=${encodeURIComponent(task.source_agreement)}`
    : null;

  return (
    <div className="group rounded-md border border-border/60 bg-card/40 px-2 py-1.5 transition-colors hover:bg-accent/30">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-1 shrink-0">
          {(task.assigned_to === "hanka" || task.assigned_to === "both") && (
            <TrafficLight status={(task.status_hanka || "not_started") as TrafficStatus} label="H" onClick={() => onToggleTraffic(task, "hanka")} />
          )}
          {(task.assigned_to === "kata" || task.assigned_to === "both") && (
            <TrafficLight status={(task.status_kata || "not_started") as TrafficStatus} label="K" onClick={() => onToggleTraffic(task, "kata")} />
          )}
        </div>
        <button className="flex-1 min-w-0 text-left truncate" onClick={() => setExpandedTask(isExpanded ? null : task.id)}>
          <span className="text-[11px] text-foreground leading-tight">{task.task}</span>
        </button>
        <div className="flex items-center gap-0 shrink-0">
          {extraActions}
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setExpandedTask(isExpanded ? null : task.id); }} className="h-5 w-5 p-0">
            {isExpanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive">
            <Trash2 className="w-2.5 h-2.5" />
          </Button>
        </div>
      </div>
      {isExpanded && (
        <div className="mt-1.5 pt-1.5 border-t border-border/30 space-y-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          {task.note && <p className="text-[10px] text-muted-foreground leading-relaxed">{task.note}</p>}
          {task.source_agreement && (
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-muted-foreground truncate max-w-[200px]">📋 {task.source_agreement.slice(0, 50)}</span>
              {driveLink && (
                <a href={driveLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[9px] text-primary hover:underline shrink-0">
                  <ExternalLink className="w-2.5 h-2.5" /> Drive
                </a>
              )}
            </div>
          )}
          {task.completed_note && (
            <div className="text-[9px] text-muted-foreground bg-muted/40 rounded px-1.5 py-1 whitespace-pre-line">
              <MessageSquare className="w-2.5 h-2.5 inline mr-0.5 opacity-60" />
              {task.completed_note}
            </div>
          )}
          <div className="flex gap-1">
            <Input
              value={noteInputs[task.id] || ""}
              onChange={(e) => setNoteInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
              placeholder="Poznámka..."
              className="flex-1 h-6 text-[9px] bg-background"
              onKeyDown={(e) => { if (e.key === "Enter") onAddNote(task.id); }}
            />
            <Button size="sm" onClick={() => onAddNote(task.id)} className="h-6 w-6 p-0" disabled={!noteInputs[task.id]?.trim()}>
              <Send className="w-2.5 h-2.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Section Header ──
const SectionHeader = ({ emoji, label, count, max }: { emoji: string; label: string; count: number; max?: number }) => (
  <div className="flex items-center justify-between mb-1">
    <span className="text-[10px] font-semibold text-foreground">{emoji} {label}</span>
    {max !== undefined && <span className="text-[8px] text-muted-foreground">{count}/{max}</span>}
  </div>
);

// ── Main Component ──
const DidTherapistTaskBoard = ({ refreshTrigger = 0 }: { refreshTrigger?: number }) => {
  const [tasks, setTasks] = useState<TherapistTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTask, setNewTask] = useState("");
  const [newAssignee, setNewAssignee] = useState<"hanka" | "kata" | "both">("both");
  const [newCategory, setNewCategory] = useState<"today" | "tomorrow" | "longterm">("today");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const loadTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from("did_therapist_tasks")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) {
      // Lifecycle: auto-archive completed tasks older than 3 days
      const now = Date.now();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      const toArchive = (data as TherapistTask[]).filter(t =>
        isAllDone(t) && t.completed_at && (now - new Date(t.completed_at).getTime()) > threeDays
      );
      if (toArchive.length > 0) {
        await supabase.from("did_therapist_tasks").delete().in("id", toArchive.map(t => t.id));
      }

      // Lifecycle: escalate stale tasks (7+ days, not done) → high priority
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const toEscalate = (data as TherapistTask[]).filter(t =>
        !isAllDone(t) && t.priority !== "high" && (now - new Date(t.created_at).getTime()) > sevenDays
      );
      if (toEscalate.length > 0) {
        await supabase.from("did_therapist_tasks").update({ priority: "high" }).in("id", toEscalate.map(t => t.id));
      }

      // Reload after lifecycle changes
      if (toArchive.length > 0 || toEscalate.length > 0) {
        const { data: fresh } = await supabase.from("did_therapist_tasks").select("*").order("created_at", { ascending: false });
        setTasks((fresh || []) as TherapistTask[]);
      } else {
        setTasks(data as TherapistTask[]);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => { if (refreshTrigger > 0) loadTasks(); }, [refreshTrigger, loadTasks]);

  const handleAddTask = async () => {
    if (!newTask.trim()) return;
    setAdding(true);
    const taskText = newTask.trim();
    const { error } = await supabase.from("did_therapist_tasks").insert({
      task: taskText,
      assigned_to: newAssignee,
      category: newCategory,
      status_hanka: "not_started",
      status_kata: "not_started",
      priority: newCategory === "today" ? "high" : newCategory === "tomorrow" ? "normal" : "low",
    });
    if (error) toast.error("Nepodařilo se přidat úkol");
    else {
      // Queue write-back to Drive
      const targetDoc = newCategory === "longterm" ? "06_Strategicky_Vyhled" : "05_Operativni_Plan";
      await supabase.from("did_pending_drive_writes").insert({
        content: `► ${taskText} [${newAssignee === "hanka" ? "Hanka" : newAssignee === "kata" ? "Káťa" : "Obě"}]`,
        target_document: targetDoc,
        write_type: "append",
        priority: newCategory === "today" ? "high" : "normal",
      }).then(({ error: writeErr }) => {
        if (writeErr) console.warn("Pending write queue error:", writeErr);
      });
      setNewTask("");
      loadTasks();
    }
    setAdding(false);
  };

  const [trafficLock, setTrafficLock] = useState(false);

  // Keep a ref to always read the latest tasks state (avoids stale closure)
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const handleToggleTraffic = async (taskArg: TherapistTask, who: "hanka" | "kata") => {
    if (trafficLock) return;
    setTrafficLock(true);

    // Read fresh state from ref, not from the render-time closure
    const freshTask = tasksRef.current.find(t => t.id === taskArg.id);
    if (!freshTask) { setTrafficLock(false); return; }

    const field = who === "hanka" ? "status_hanka" : "status_kata";
    const current = (freshTask[field] || "not_started") as TrafficStatus;
    const next = NEXT_STATUS[current];
    const updates: Record<string, string> = { [field]: next, updated_at: new Date().toISOString() };

    const otherField = who === "hanka" ? "status_kata" : "status_hanka";
    const otherStatus = (freshTask[otherField] || "not_started") as TrafficStatus;
    const bothDone = next === "done" && (freshTask.assigned_to !== "both" || otherStatus === "done");
    if (bothDone) {
      updates.status = "done";
      updates.completed_at = new Date().toISOString();
    } else {
      updates.status = "pending";
      updates.completed_at = null as any;
    }

    // Optimistic update: immediately reflect change in UI
    setTasks(prev => prev.map(t =>
      t.id === freshTask.id ? { ...t, ...updates } as TherapistTask : t
    ));

    const { error } = await supabase.from("did_therapist_tasks").update(updates).eq("id", freshTask.id);
    if (error) {
      toast.error("Nepodařilo se změnit stav");
      await loadTasks(); // revert on error
    } else if (bothDone) {
      // Update motivation profile on task completion
      updateMotivationProfile(who === "hanka" ? "Hanka" : "Káťa", "completed", freshTask.created_at);
      if (freshTask.assigned_to === "both") {
        updateMotivationProfile(who === "hanka" ? "Káťa" : "Hanka", "completed", freshTask.created_at);
      }
    }
    setTrafficLock(false);
  };

  const updateMotivationProfile = async (therapist: string, event: "completed" | "missed", taskCreatedAt: string) => {
    try {
      const { data: existing } = await supabase
        .from("did_motivation_profiles")
        .select("*")
        .eq("therapist", therapist)
        .maybeSingle();

      const daysTaken = Math.max(1, Math.round((Date.now() - new Date(taskCreatedAt).getTime()) / (24 * 60 * 60 * 1000)));

      if (existing) {
        const completed = (existing.tasks_completed || 0) + (event === "completed" ? 1 : 0);
        const missed = (existing.tasks_missed || 0) + (event === "missed" ? 1 : 0);
        const totalCompleted = completed;
        const avgDays = totalCompleted > 0
          ? ((Number(existing.avg_completion_days || 0) * (totalCompleted - 1) + daysTaken) / totalCompleted)
          : 0;
        const streak = event === "completed" ? (existing.streak_current || 0) + 1 : 0;
        const bestStreak = Math.max(streak, existing.streak_best || 0);

        // Adapt style based on patterns
        let style = existing.preferred_style || "balanced";
        if (completed > 5) {
          const ratio = completed / Math.max(1, completed + missed);
          if (ratio > 0.8) style = "praise"; // responds well to encouragement
          else if (avgDays > 4) style = "deadline"; // needs deadline pressure
          else style = "instruction"; // needs clear instructions
        }

        await supabase.from("did_motivation_profiles").update({
          tasks_completed: completed,
          tasks_missed: missed,
          avg_completion_days: Math.round(avgDays * 100) / 100,
          streak_current: streak,
          streak_best: bestStreak,
          preferred_style: style,
          last_active_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await supabase.from("did_motivation_profiles").insert({
          therapist,
          tasks_completed: event === "completed" ? 1 : 0,
          tasks_missed: event === "missed" ? 1 : 0,
          avg_completion_days: event === "completed" ? daysTaken : 0,
          streak_current: event === "completed" ? 1 : 0,
          preferred_style: "balanced",
        });
      }
    } catch (e) {
      console.warn("Motivation profile update error:", e);
    }
  };

  const handleDelete = async (taskId: string) => {
    await supabase.from("did_therapist_tasks").delete().eq("id", taskId);
    loadTasks();
    toast.success("Úkol odstraněn");
  };

  const handleAddNote = async (taskId: string) => {
    const note = noteInputs[taskId]?.trim();
    if (!note) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const existingNote = task.completed_note || "";
    const dateStr = new Date().toLocaleDateString("cs-CZ");
    const updatedNote = existingNote ? `${existingNote}\n[${dateStr}] ${note}` : `[${dateStr}] ${note}`;
    await supabase.from("did_therapist_tasks").update({ completed_note: updatedNote, updated_at: new Date().toISOString() }).eq("id", taskId);
    setNoteInputs(prev => ({ ...prev, [taskId]: "" }));
    loadTasks();
    toast.success("Poznámka přidána");
  };

  const handlePromote = async (taskId: string, to: "today" | "tomorrow") => {
    await supabase.from("did_therapist_tasks").update({
      category: to,
      priority: to === "today" ? "high" : "normal",
      updated_at: new Date().toISOString(),
    }).eq("id", taskId);
    loadTasks();
    toast.success(`Úkol přesunut do ${to === "today" ? "DNES" : "ZÍTRA"}`);
  };

  const assigneeFull = (a: string) => a === "hanka" ? "Hanka" : a === "kata" ? "Káťa" : "Obě";

  // Categorize tasks — use ALL tasks (not just active) for section visibility
  const active = tasks.filter(t => !isAllDone(t));
  const done = tasks.filter(t => isAllDone(t));

  const todayTasks = active.filter(t => t.category === "today" || t.category === "daily");
  const tomorrowTasks = active.filter(t => t.category === "tomorrow");
  // Also check if there are ANY tomorrow tasks (including done) so we can show the section
  const allTomorrowTasks = tasks.filter(t => t.category === "tomorrow");
  const longtermTasks = active.filter(t => t.category === "longterm" || t.category === "weekly" || (!["today", "tomorrow", "daily"].includes(t.category || "")));

  // Separate longterm into actual longterm list items vs general/uncategorized with traffic lights
  const generalActive = longtermTasks.filter(t => t.category === "general" || !t.category);
  const longtermList = longtermTasks.filter(t => t.category === "longterm" || t.category === "weekly");

  const sharedProps = { expandedTask, setExpandedTask, noteInputs, setNoteInputs, onToggleTraffic: handleToggleTraffic, onDelete: handleDelete, onAddNote: handleAddNote };

  if (loading) {
    return <div className="flex items-center justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      {/* Add new task */}
      <div className="space-y-1">
        <div className="flex gap-1.5 items-center">
          <Input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="Nový úkol..." className="flex-1 h-7 text-[11px] bg-background" onKeyDown={(e) => { if (e.key === "Enter") handleAddTask(); }} />
          <Button size="sm" onClick={handleAddTask} disabled={!newTask.trim() || adding} className="h-7 w-7 p-0">
            {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          </Button>
        </div>
        <div className="flex gap-0.5 flex-wrap">
          {(["today", "tomorrow", "longterm"] as const).map(c => (
            <Button key={c} variant={newCategory === c ? "default" : "ghost"} size="sm" onClick={() => setNewCategory(c)} className="h-5 text-[8px] px-1.5 min-w-0">
              {c === "today" ? "Dnes" : c === "tomorrow" ? "Zítra" : "Dlouhodobé"}
            </Button>
          ))}
          <span className="text-[8px] text-muted-foreground self-center mx-1">|</span>
          {(["both", "hanka", "kata"] as const).map(a => (
            <Button key={a} variant={newAssignee === a ? "default" : "ghost"} size="sm" onClick={() => setNewAssignee(a)} className="h-5 text-[8px] px-1.5 min-w-0">
              {assigneeFull(a)}
            </Button>
          ))}
        </div>
      </div>

      {/* DNES */}
      {todayTasks.length > 0 && (
        <div>
          <SectionHeader emoji="🔴" label="DNES" count={todayTasks.length} max={MAX_TODAY} />
          <div className="space-y-1">
            {todayTasks.slice(0, MAX_TODAY).map(task => <TaskCard key={task.id} task={task} {...sharedProps} />)}
            {todayTasks.length > MAX_TODAY && <p className="text-[8px] text-muted-foreground text-center">+{todayTasks.length - MAX_TODAY} skrytých (Karel je přidá později)</p>}
          </div>
        </div>
      )}

      {/* ZÍTRA — show section if there are any tomorrow tasks (active or done) */}
      {(tomorrowTasks.length > 0 || allTomorrowTasks.length > 0) && (
        <div>
          <SectionHeader emoji="🟡" label="ZÍTRA" count={tomorrowTasks.length} max={MAX_TOMORROW} />
          {tomorrowTasks.length > 0 ? (
            <div className="space-y-1">
              {tomorrowTasks.slice(0, MAX_TOMORROW).map(task => <TaskCard key={task.id} task={task} {...sharedProps} />)}
              {tomorrowTasks.length > MAX_TOMORROW && <p className="text-[8px] text-muted-foreground text-center">+{tomorrowTasks.length - MAX_TOMORROW} skrytých</p>}
            </div>
          ) : (
            <p className="text-[9px] text-muted-foreground text-center py-1.5">Všechny úkoly na zítra splněny ✅</p>
          )}
        </div>
      )}

      {/* General uncategorized active tasks with traffic lights */}
      {generalActive.length > 0 && (
        <div>
          <SectionHeader emoji="📌" label="Aktivní úkoly" count={generalActive.length} />
          <div className="space-y-1">
            {generalActive.map(task => <TaskCard key={task.id} task={task} {...sharedProps} />)}
          </div>
        </div>
      )}

      {/* Empty state */}
      {active.length === 0 && done.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center py-3">Zatím žádné úkoly.</p>
      )}

      {/* DLOUHODOBÉ — clean expandable list, no traffic lights */}
      {longtermList.length > 0 && (
        <div>
          <SectionHeader emoji="📋" label="Dlouhodobé" count={longtermList.length} max={MAX_LONGTERM} />
          <div className="space-y-0.5">
            {longtermList.slice(0, MAX_LONGTERM).map(task => {
              const isExp = expandedTask === task.id;
              const driveLink = task.source_agreement?.startsWith("http")
                ? task.source_agreement
                : null;
              const priorityLabel = task.priority === "high" ? "⚡ Urgentní" : task.priority === "normal" ? "📌 Běžná" : "🕐 Nízká";
              const assigneeLabel = task.assigned_to === "hanka" ? "👩 Hanka" : task.assigned_to === "kata" ? "👩‍🦰 Káťa" : "👩‍👩‍👧 Obě";

              return (
                <div key={task.id} className="group">
                  <div className="flex items-center gap-1.5">
                    <button
                      className="flex-1 min-w-0 text-left py-1 px-1.5 rounded transition-colors hover:bg-accent/30"
                      onClick={() => setExpandedTask(isExp ? null : task.id)}
                    >
                      <span className="text-[11px] text-foreground/80 leading-tight">{task.task}</span>
                    </button>
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handlePromote(task.id, "today"); }} className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity" title="Povýšit na DNES">
                      <ArrowUp className="w-2.5 h-2.5 text-primary" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }} className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="w-2.5 h-2.5" />
                    </Button>
                  </div>

                  {isExp && (
                    <div className="ml-1.5 pl-2.5 border-l-2 border-primary/20 mb-2 mt-0.5 space-y-1 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                      {task.note && <p className="text-[10px] text-muted-foreground leading-relaxed">{task.note}</p>}

                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
                        <span>{priorityLabel}</span>
                        <span>{assigneeLabel}</span>
                        {task.due_date && <span>📅 {new Date(task.due_date).toLocaleDateString("cs-CZ")}</span>}
                      </div>

                      {task.source_agreement && (
                        <div className="flex items-center gap-1 text-[9px]">
                          <span className="text-muted-foreground truncate max-w-[220px]">📄 {task.source_agreement}</span>
                          {driveLink && (
                            <a href={driveLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline shrink-0">
                              <ExternalLink className="w-2.5 h-2.5" /> Otevřít
                            </a>
                          )}
                        </div>
                      )}

                      {task.completed_note && (
                        <div className="text-[9px] text-muted-foreground bg-muted/30 rounded px-1.5 py-1 whitespace-pre-line">
                          <MessageSquare className="w-2.5 h-2.5 inline mr-0.5 opacity-60" />
                          {task.completed_note}
                        </div>
                      )}

                      <div className="flex gap-1 pt-0.5">
                        <Input
                          value={noteInputs[task.id] || ""}
                          onChange={(e) => setNoteInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                          placeholder="Poznámka..."
                          className="flex-1 h-6 text-[9px] bg-background"
                          onKeyDown={(e) => { if (e.key === "Enter") handleAddNote(task.id); }}
                        />
                        <Button size="sm" onClick={() => handleAddNote(task.id)} className="h-6 w-6 p-0" disabled={!noteInputs[task.id]?.trim()}>
                          <Send className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {longtermList.length > MAX_LONGTERM && <p className="text-[8px] text-muted-foreground text-center pt-1">+{longtermList.length - MAX_LONGTERM} dalších na Drive</p>}
          </div>
        </div>
      )}

      {/* Splněné */}
      {done.length > 0 && (
        <details className="group/done">
          <summary className="text-[9px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
            ✅ Splněné ({done.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {done.slice(0, 10).map(task => (
              <div key={task.id} className="rounded px-2 py-1 bg-muted/20 flex items-center gap-1.5 opacity-50">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-[10px] text-muted-foreground line-through flex-1 truncate">{task.task}</span>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(task.id)} className="h-4 w-4 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/done:opacity-100">
                  <Trash2 className="w-2 h-2" />
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export default DidTherapistTaskBoard;
