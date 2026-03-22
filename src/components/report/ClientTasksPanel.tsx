import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, Trash2, Plus, ArrowUpFromDot } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

interface ClientTask {
  id: string;
  task: string;
  method: string;
  status: string;
  due_date: string | null;
  result: string;
  notes: string;
  task_type?: string;
  priority?: string;
  answer?: string;
  created_at: string;
  for_session?: number | null;
}

interface ClientTasksPanelProps {
  clientId: string;
  clientName: string;
  tasks: ClientTask[];
  onRefresh: () => void;
}

const PRIORITY_ICON: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

const ClientTasksPanel = ({ clientId, clientName, tasks, onRefresh }: ClientTasksPanelProps) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isRedistributing, setIsRedistributing] = useState(false);
  const [newTaskText, setNewTaskText] = useState("");

  const doneTasks = tasks.filter(t => t.status === "done");
  const manualTasks = tasks.filter(t => (!t.task_type || t.task_type === "manual") && t.status !== "done");

  // Group therapist_question + client_homework by for_session
  const sessionGroups = useMemo(() => {
    const grouped: Record<string, ClientTask[]> = {};
    tasks
      .filter(t => (t.task_type === "therapist_question" || t.task_type === "client_homework") && t.status !== "done")
      .forEach(t => {
        const key = t.for_session != null ? String(t.for_session) : "unassigned";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(t);
      });
    // Sort keys numerically, unassigned last
    return Object.entries(grouped).sort(([a], [b]) => {
      if (a === "unassigned") return 1;
      if (b === "unassigned") return -1;
      return Number(a) - Number(b);
    });
  }, [tasks]);

  const answeredQuestions = tasks.filter(t => t.task_type === "therapist_question" && t.status !== "done" && answers[t.id]?.trim());

  const handleRedistribute = async () => {
    if (answeredQuestions.length === 0) { toast.error("Nejdřív vyplň odpovědi"); return; }
    setIsRedistributing(true);
    try {
      const completedTasks = answeredQuestions.map(t => ({
        taskId: t.id,
        question: t.task,
        answer: answers[t.id],
      }));

      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-task-redistribute`,
        { method: "POST", headers, body: JSON.stringify({ clientId, completedTasks }) }
      );

      if (!res.ok) throw new Error("Chyba při zapracování");
      const data = await res.json();
      toast.success(data.summary || "Odpovědi zapracovány do karty");
      setAnswers({});
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Chyba");
    } finally {
      setIsRedistributing(false);
    }
  };

  const handleToggle = async (task: ClientTask) => {
    const nextStatus = task.status === "done" ? "planned" : "done";
    await supabase.from("client_tasks").update({ status: nextStatus }).eq("id", task.id);
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await supabase.from("client_tasks").delete().eq("id", id);
    onRefresh();
  };

  const handleAdd = async () => {
    if (!newTaskText.trim()) return;
    await supabase.from("client_tasks").insert({ client_id: clientId, task: newTaskText.trim() });
    setNewTaskText("");
    onRefresh();
  };

  const handleDueDateChange = async (taskIds: string[], date: string) => {
    const value = date || null;
    await Promise.all(taskIds.map(id =>
      supabase.from("client_tasks").update({ due_date: value }).eq("id", id)
    ));
    onRefresh();
  };

  const renderTaskItem = (t: ClientTask, showAnswer: boolean) => (
    <div key={t.id} className="p-3 bg-muted/20 rounded-lg space-y-2">
      <div className="flex items-start gap-2">
        <span className="text-sm shrink-0">{PRIORITY_ICON[t.priority || "medium"] || "🟡"}</span>
        <p className="text-sm flex-1">{t.task}</p>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => handleDelete(t.id)}>
          <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
        </Button>
      </div>
      {showAnswer && (
        <Input
          placeholder="Odpověď…"
          value={answers[t.id] || ""}
          onChange={(e) => setAnswers(p => ({ ...p, [t.id]: e.target.value }))}
          className="h-8 text-sm"
        />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Session-grouped tasks */}
      {sessionGroups.map(([key, groupTasks]) => {
        const therapistTasks = groupTasks.filter(t => t.task_type === "therapist_question");
        const homeworkTasks = groupTasks.filter(t => t.task_type === "client_homework");
        const sessionNum = key === "unassigned" ? null : Number(key);
        const firstDate = groupTasks[0]?.created_at;
        const formattedDate = firstDate ? new Date(firstDate).toLocaleDateString("cs-CZ") : "";
        const groupDueDate = groupTasks[0]?.due_date || "";

        return (
          <div key={key} className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h4 className="text-sm font-semibold">
                {sessionNum != null
                  ? `ZE SEZENÍ č. ${sessionNum - 1} – ${formattedDate}`
                  : `📋 Úkoly bez přiřazení`}
              </h4>
              {sessionNum != null && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Do sezení č. {sessionNum}:</span>
                  <Input
                    type="date"
                    value={groupDueDate}
                    onChange={(e) => handleDueDateChange(groupTasks.map(t => t.id), e.target.value)}
                    className="h-7 w-[140px] text-xs"
                  />
                </div>
              )}
            </div>

            {therapistTasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">PRO TERAPEUTA</p>
                {therapistTasks.map(t => renderTaskItem(t, true))}
              </div>
            )}

            {homeworkTasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">PRO KLIENTA</p>
                {homeworkTasks.map(t => renderTaskItem(t, false))}
              </div>
            )}
          </div>
        );
      })}

      {/* Redistribute button */}
      {answeredQuestions.length > 0 && (
        <Button onClick={handleRedistribute} disabled={isRedistributing} className="w-full gap-1.5" size="sm">
          {isRedistributing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpFromDot className="w-4 h-4" />}
          Zapracovat {answeredQuestions.length} odpovědí do karty
        </Button>
      )}

      {/* Manual tasks */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h4 className="text-sm font-semibold">Vlastní úkoly</h4>
        <div className="flex gap-2">
          <Input
            placeholder="Nový úkol / intervence…"
            value={newTaskText}
            onChange={(e) => setNewTaskText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
            className="flex-1"
          />
          <Button size="sm" onClick={handleAdd} disabled={!newTaskText.trim()}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        {manualTasks.length === 0 && doneTasks.length === 0 && sessionGroups.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">Zatím žádné úkoly.</p>
        )}

        {manualTasks.map(t => (
          <div key={t.id} className="flex items-start gap-2 py-1.5">
            <button onClick={() => handleToggle(t)} className="mt-0.5 shrink-0">
              <div className="w-5 h-5 rounded border-2 border-muted-foreground/30" />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm">{t.task}</p>
              {t.method && <p className="text-xs text-muted-foreground">Metoda: {t.method}</p>}
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => handleDelete(t.id)}>
              <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
            </Button>
          </div>
        ))}

        {doneTasks.length > 0 && (
          <div className="pt-2 border-t border-border space-y-1">
            <p className="text-xs text-muted-foreground">Hotové ({doneTasks.length})</p>
            {doneTasks.slice(0, 5).map(t => (
              <div key={t.id} className="flex items-center gap-2 py-1 opacity-50">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm line-through">{t.task}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ClientTasksPanel;
