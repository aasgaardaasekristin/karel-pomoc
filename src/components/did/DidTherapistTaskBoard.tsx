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
  not_started: "bg-red-500",
  in_progress: "bg-orange-400",
  done: "bg-green-500",
};

const TRAFFIC_RING: Record<TrafficStatus, string> = {
  not_started: "ring-red-500/30",
  in_progress: "ring-orange-400/30",
  done: "ring-green-500/30",
};

const NEXT_STATUS: Record<TrafficStatus, TrafficStatus> = {
  not_started: "in_progress",
  in_progress: "done",
  done: "not_started",
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
    className="flex items-center gap-1 group"
    title={`${label}: ${status === "not_started" ? "Nezapočato" : status === "in_progress" ? "Rozpracováno" : "Splněno"}`}
  >
    <span
      className={`w-3 h-3 rounded-full ${TRAFFIC_COLORS[status]} ring-2 ${TRAFFIC_RING[status]} transition-all group-hover:scale-125 group-hover:ring-4`}
    />
    <span className="text-[9px] text-muted-foreground">{label}</span>
  </button>
);

const DidTherapistTaskBoard = () => {
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

    // Derive overall status from both
    const otherField = who === "hanka" ? "status_kata" : "status_hanka";
    const otherStatus = (task[otherField] || "not_started") as TrafficStatus;
    const bothDone = next === "done" && (task.assigned_to !== "both" || otherStatus === "done");
    if (bothDone) {
      updates.status = "done";
      updates.completed_at = new Date().toISOString();
    } else {
      updates.status = "pending";
      updates.completed_at = "";
    }

    await supabase.from("did_therapist_tasks").update(updates).eq("id", task.id);
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
    if (a === "hanka") return "Hanka";
    if (a === "kata") return "Káťa";
    return "Obě";
  };

  const assigneeColor = (a: string) => {
    if (a === "hanka") return "bg-pink-500/10 text-pink-600 border-pink-500/20";
    if (a === "kata") return "bg-blue-500/10 text-blue-600 border-blue-500/20";
    return "bg-primary/10 text-primary border-primary/20";
  };

  const getDriveLink = (task: TherapistTask) => {
    if (!task.source_agreement) return null;
    // If it looks like a Drive file ID or URL, use it directly
    if (task.source_agreement.startsWith("http")) return task.source_agreement;
    // Otherwise construct a search link
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
    <div className="space-y-3">
      {/* Add new task */}
      <div className="rounded-lg border border-border bg-card/50 p-3 space-y-2">
        <div className="flex gap-2">
          <Input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="Nový úkol pro terapeuta..."
            className="flex-1 h-8 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") handleAddTask(); }}
          />
          <Button size="sm" onClick={handleAddTask} disabled={!newTask.trim() || adding} className="h-8 px-2">
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          </Button>
        </div>
        <div className="flex gap-1">
          {(["both", "hanka", "kata"] as const).map(a => (
            <Button
              key={a}
              variant={newAssignee === a ? "default" : "outline"}
              size="sm"
              onClick={() => setNewAssignee(a)}
              className="h-6 text-[10px] px-2"
            >
              {assigneeLabel(a)}
            </Button>
          ))}
        </div>
      </div>

      {/* Active tasks */}
      {activeTasks.length === 0 && doneTasks.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">Zatím žádné úkoly.</p>
      )}

      {activeTasks.map(task => {
        const isExpanded = expandedTask === task.id;
        const driveLink = getDriveLink(task);

        return (
          <div key={task.id} className="rounded-lg border border-border bg-card/50 p-2.5 transition-colors hover:border-primary/20">
            <div className="flex items-center gap-2">
              {/* Traffic lights */}
              <div className="flex flex-col gap-1 shrink-0">
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

              {/* Task content */}
              <button
                className="flex-1 min-w-0 text-left"
                onClick={() => setExpandedTask(isExpanded ? null : task.id)}
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium text-foreground leading-tight">{task.task}</span>
                  <Badge variant="outline" className={`text-[9px] px-1 py-0 ${assigneeColor(task.assigned_to)}`}>
                    {assigneeLabel(task.assigned_to)}
                  </Badge>
                </div>
              </button>

              {/* Actions */}
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpandedTask(isExpanded ? null : task.id)}
                  className="h-6 w-6 p-0"
                >
                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(task.id)}
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="mt-2 pt-2 border-t border-border/50 space-y-2">
                {/* Note / detail description */}
                {task.note && (
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{task.note}</p>
                )}
                {task.source_agreement && (
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      📋 {task.source_agreement.slice(0, 50)}
                    </Badge>
                    {driveLink && (
                      <a
                        href={driveLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[9px] text-primary hover:underline"
                      >
                        <ExternalLink className="w-2.5 h-2.5" />
                        Otevřít v Drive
                      </a>
                    )}
                  </div>
                )}

                {/* Existing notes */}
                {task.completed_note && (
                  <div className="text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5 whitespace-pre-line">
                    <MessageSquare className="w-3 h-3 inline mr-1" />
                    {task.completed_note}
                  </div>
                )}

                {/* Add note */}
                <div className="flex gap-1.5">
                  <Input
                    value={noteInputs[task.id] || ""}
                    onChange={(e) => setNoteInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                    placeholder="Poznámka / vzkaz..."
                    className="flex-1 h-7 text-[10px]"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddNote(task.id); }}
                  />
                  <Button size="sm" onClick={() => handleAddNote(task.id)} className="h-7 px-2" disabled={!noteInputs[task.id]?.trim()}>
                    <Send className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Done tasks */}
      {doneTasks.length > 0 && (
        <details className="group">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            ✅ Splněné ({doneTasks.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {doneTasks.slice(0, 10).map(task => (
              <div key={task.id} className="rounded-lg border border-border/50 bg-muted/30 p-2 opacity-60 flex items-center gap-2">
                <div className="flex flex-col gap-0.5 shrink-0">
                  {(task.assigned_to === "hanka" || task.assigned_to === "both") && (
                    <span className="w-3 h-3 rounded-full bg-green-500 ring-2 ring-green-500/30" />
                  )}
                  {(task.assigned_to === "kata" || task.assigned_to === "both") && (
                    <span className="w-3 h-3 rounded-full bg-green-500 ring-2 ring-green-500/30" />
                  )}
                </div>
                <span className="text-xs text-muted-foreground line-through flex-1">{task.task}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(task.id)}
                  className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-2.5 h-2.5" />
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
