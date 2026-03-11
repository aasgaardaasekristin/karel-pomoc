import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, MessageSquare, ChevronDown, ChevronUp, Send } from "lucide-react";
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
}

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
    });
    if (error) toast.error("Nepodařilo se přidat úkol");
    else { setNewTask(""); loadTasks(); }
    setAdding(false);
  };

  const handleToggleStatus = async (task: TherapistTask) => {
    const newStatus = task.status === "done" ? "pending" : "done";
    const updates: any = {
      status: newStatus,
      updated_at: new Date().toISOString(),
      completed_at: newStatus === "done" ? new Date().toISOString() : null,
    };
    await supabase.from("did_therapist_tasks").update(updates).eq("id", task.id);
    loadTasks();
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

  const pendingTasks = tasks.filter(t => t.status !== "done");
  const doneTasks = tasks.filter(t => t.status === "done");

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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

      {/* Pending tasks */}
      {pendingTasks.length === 0 && doneTasks.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">Zatím žádné úkoly. Karel je vytvoří při týdenním cyklu.</p>
      )}

      {pendingTasks.map(task => (
        <div key={task.id} className="rounded-lg border border-border bg-card/50 p-3">
          <div className="flex items-start gap-2">
            <Checkbox
              checked={false}
              onCheckedChange={() => handleToggleStatus(task)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium text-foreground">{task.task}</span>
                <Badge variant="outline" className={`text-[9px] px-1 py-0 ${assigneeColor(task.assigned_to)}`}>
                  {assigneeLabel(task.assigned_to)}
                </Badge>
                {task.source_agreement && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0">
                    📋 {task.source_agreement.slice(0, 30)}
                  </Badge>
                )}
              </div>
              {task.note && (
                <p className="text-[10px] text-muted-foreground mt-0.5">{task.note}</p>
              )}
              {task.completed_note && (
                <div className="mt-1 text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5 whitespace-pre-line">
                  <MessageSquare className="w-3 h-3 inline mr-1" />
                  {task.completed_note}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
              className="h-6 w-6 p-0 shrink-0"
            >
              {expandedTask === task.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </Button>
          </div>

          {expandedTask === task.id && (
            <div className="mt-2 flex gap-1.5">
              <Input
                value={noteInputs[task.id] || ""}
                onChange={(e) => setNoteInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                placeholder="Poznámka / vzkaz pro druhou terapeutku..."
                className="flex-1 h-7 text-[10px]"
                onKeyDown={(e) => { if (e.key === "Enter") handleAddNote(task.id); }}
              />
              <Button size="sm" onClick={() => handleAddNote(task.id)} className="h-7 px-2" disabled={!noteInputs[task.id]?.trim()}>
                <Send className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
      ))}

      {/* Done tasks */}
      {doneTasks.length > 0 && (
        <details className="group">
          <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            ✅ Splněné úkoly ({doneTasks.length})
          </summary>
          <div className="mt-2 space-y-2">
            {doneTasks.slice(0, 10).map(task => (
              <div key={task.id} className="rounded-lg border border-border/50 bg-muted/30 p-2.5 opacity-70">
                <div className="flex items-start gap-2">
                  <Checkbox
                    checked={true}
                    onCheckedChange={() => handleToggleStatus(task)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-muted-foreground line-through">{task.task}</span>
                    <Badge variant="outline" className={`ml-1.5 text-[9px] px-1 py-0 ${assigneeColor(task.assigned_to)}`}>
                      {assigneeLabel(task.assigned_to)}
                    </Badge>
                    {task.completed_note && (
                      <div className="mt-1 text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5 whitespace-pre-line">
                        <MessageSquare className="w-3 h-3 inline mr-1" />
                        {task.completed_note}
                      </div>
                    )}
                    {task.completed_at && (
                      <p className="text-[9px] text-muted-foreground mt-0.5">
                        Splněno: {new Date(task.completed_at).toLocaleDateString("cs-CZ")}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export default DidTherapistTaskBoard;
