import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, MessageSquare, ChevronDown, ChevronUp, Send, Trash2, ExternalLink } from "lucide-react";
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

const TrafficLight = ({
  status,
  label,
  onClick,
}: {
  status: TrafficStatus;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1 group cursor-pointer"
    title={`${label}: ${STATUS_LABEL[status]}`}
  >
    <span
      className={`w-2.5 h-2.5 rounded-full ${TRAFFIC_COLORS[status]} shadow-sm transition-all duration-200 group-hover:scale-150 group-hover:shadow-md`}
    />
    <span className="text-[8px] font-medium text-muted-foreground opacity-70">{label}</span>
  </button>
);

const DidTherapistTaskBoard = ({ refreshTrigger = 0 }: { refreshTrigger?: number }) => {
  const [tasks, setTasks] = useState<TherapistTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTask, setNewTask] = useState("");
  const [newAssignee, setNewAssignee] = useState<"hanka" | "kata" | "both">("both");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  const loadTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from("did_therapist_tasks")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) setTasks(data as TherapistTask[]);
    setLoading(false);
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  useEffect(() => {
    if (refreshTrigger > 0) loadTasks();
  }, [refreshTrigger, loadTasks]);

  const handleAddTask = async () => {
    if (!newTask.trim()) return;
    setAdding(true);
    const { error } = await supabase.from("did_therapist_tasks").insert({
      task: newTask.trim(),
      assigned_to: newAssignee,
      status_hanka: "not_started",
      status_kata: "not_started",
    });
    if (error) toast.error("Nepodařilo se přidat úkol");
    else { setNewTask(""); loadTasks(); }
    setAdding(false);
  };

  const handleToggleTraffic = async (task: TherapistTask, who: "hanka" | "kata") => {
    const field = who === "hanka" ? "status_hanka" : "status_kata";
    const current = (task[field] || "not_started") as TrafficStatus;
    const next = NEXT_STATUS[current];

    const updates: Record<string, string> = {
      [field]: next,
      updated_at: new Date().toISOString(),
    };

    const otherField = who === "hanka" ? "status_kata" : "status_hanka";
    const otherStatus = (task[otherField] || "not_started") as TrafficStatus;
    const bothDone = next === "done" && (task.assigned_to !== "both" || otherStatus === "done");
    if (bothDone) {
      updates.status = "done";
      updates.completed_at = new Date().toISOString();
    } else {
      updates.status = "pending";
      updates.completed_at = null as any;
    }

    const { error } = await supabase.from("did_therapist_tasks").update(updates).eq("id", task.id);
    if (error) {
      console.error("Traffic light update error:", error);
      toast.error("Nepodařilo se změnit stav");
    }
    loadTasks();
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
    const updatedNote = existingNote
      ? `${existingNote}\n[${dateStr}] ${note}`
      : `[${dateStr}] ${note}`;

    await supabase.from("did_therapist_tasks").update({
      completed_note: updatedNote,
      updated_at: new Date().toISOString(),
    }).eq("id", taskId);

    setNoteInputs(prev => ({ ...prev, [taskId]: "" }));
    loadTasks();
    toast.success("Poznámka přidána");
  };

  const assigneeLabel = (a: string) => {
    if (a === "hanka") return "H";
    if (a === "kata") return "K";
    return "H+K";
  };

  const assigneeFull = (a: string) => {
    if (a === "hanka") return "Hanka";
    if (a === "kata") return "Káťa";
    return "Obě";
  };

  const getDriveLink = (task: TherapistTask) => {
    if (!task.source_agreement) return null;
    if (task.source_agreement.startsWith("http")) return task.source_agreement;
    return `https://drive.google.com/drive/search?q=${encodeURIComponent(task.source_agreement)}`;
  };

  const isAllDone = (task: TherapistTask) => {
    if (task.assigned_to === "hanka") return task.status_hanka === "done";
    if (task.assigned_to === "kata") return task.status_kata === "done";
    return task.status_hanka === "done" && task.status_kata === "done";
  };

  const activeTasks = tasks.filter(t => !isAllDone(t));
  const doneTasks = tasks.filter(t => isAllDone(t));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Add new task — compact */}
      <div className="flex gap-1.5 items-center">
        <Input
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
          placeholder="Nový úkol..."
          className="flex-1 h-7 text-[11px] bg-background"
          onKeyDown={(e) => { if (e.key === "Enter") handleAddTask(); }}
        />
        <div className="flex gap-0.5">
          {(["both", "hanka", "kata"] as const).map(a => (
            <Button
              key={a}
              variant={newAssignee === a ? "default" : "ghost"}
              size="sm"
              onClick={() => setNewAssignee(a)}
              className="h-7 text-[9px] px-1.5 min-w-0"
            >
              {assigneeFull(a)}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={handleAddTask} disabled={!newTask.trim() || adding} className="h-7 w-7 p-0">
          {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
        </Button>
      </div>

      {/* Active tasks */}
      {activeTasks.length === 0 && doneTasks.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center py-3">Zatím žádné úkoly.</p>
      )}

      <div className="space-y-1">
        {activeTasks.map(task => {
          const isExpanded = expandedTask === task.id;
          const driveLink = getDriveLink(task);

          return (
            <div
              key={task.id}
              className="group rounded-md border border-border/60 bg-card/40 px-2 py-1.5 transition-colors hover:bg-accent/30"
            >
              <div className="flex items-center gap-1.5">
                {/* Traffic lights — tiny inline */}
                <div className="flex items-center gap-1 shrink-0">
                  {(task.assigned_to === "hanka" || task.assigned_to === "both") && (
                    <TrafficLight
                      status={(task.status_hanka || "not_started") as TrafficStatus}
                      label="H"
                      onClick={() => handleToggleTraffic(task, "hanka")}
                    />
                  )}
                  {(task.assigned_to === "kata" || task.assigned_to === "both") && (
                    <TrafficLight
                      status={(task.status_kata || "not_started") as TrafficStatus}
                      label="K"
                      onClick={() => handleToggleTraffic(task, "kata")}
                    />
                  )}
                </div>

                {/* Task text */}
                <button
                  className="flex-1 min-w-0 text-left truncate"
                  onClick={() => setExpandedTask(isExpanded ? null : task.id)}
                >
                  <span className="text-[11px] text-foreground leading-tight">{task.task}</span>
                </button>

                {/* Compact actions */}
                <div className="flex items-center gap-0 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedTask(isExpanded ? null : task.id)}
                    className="h-5 w-5 p-0"
                  >
                    {isExpanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(task.id)}
                    className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </Button>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="mt-1.5 pt-1.5 border-t border-border/30 space-y-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                  {task.note && (
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{task.note}</p>
                  )}
                  {task.source_agreement && (
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-muted-foreground truncate max-w-[200px]">
                        📋 {task.source_agreement.slice(0, 50)}
                      </span>
                      {driveLink && (
                        <a
                          href={driveLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-[9px] text-primary hover:underline shrink-0"
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          Drive
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
      </div>

      {/* Done tasks */}
      {doneTasks.length > 0 && (
        <details className="group/done">
          <summary className="text-[9px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
            ✅ Splněné ({doneTasks.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {doneTasks.slice(0, 10).map(task => (
              <div key={task.id} className="rounded px-2 py-1 bg-muted/20 flex items-center gap-1.5 opacity-50">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-[10px] text-muted-foreground line-through flex-1 truncate">{task.task}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(task.id)}
                  className="h-4 w-4 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/done:opacity-100"
                >
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
