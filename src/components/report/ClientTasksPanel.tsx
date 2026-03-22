import { useState } from "react";
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
}

interface ClientTasksPanelProps {
  clientId: string;
  clientName: string;
  tasks: ClientTask[];
  onRefresh: () => void;
}

const ClientTasksPanel = ({ clientId, clientName, tasks, onRefresh }: ClientTasksPanelProps) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isRedistributing, setIsRedistributing] = useState(false);
  const [newTaskText, setNewTaskText] = useState("");

  const questionTasks = tasks.filter(t => t.task_type === "therapist_question" && t.status !== "done");
  const homeworkTasks = tasks.filter(t => t.task_type === "client_homework" && t.status !== "done");
  const manualTasks = tasks.filter(t => (!t.task_type || t.task_type === "manual") && t.status !== "done");
  const doneTasks = tasks.filter(t => t.status === "done");

  const highPriority = questionTasks.filter(t => t.priority === "high");
  const medPriority = questionTasks.filter(t => t.priority === "medium");
  const lowPriority = questionTasks.filter(t => t.priority === "low" || !t.priority);

  const answeredQuestions = questionTasks.filter(t => answers[t.id]?.trim());

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

  const renderQuestionGroup = (label: string, color: string, items: ClientTask[]) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">{color} {label}</p>
        {items.map(t => (
          <div key={t.id} className="p-3 bg-muted/20 rounded-lg space-y-2">
            <p className="text-sm">{t.task}</p>
            <div className="flex gap-2">
              <Input
                placeholder="Odpověď…"
                value={answers[t.id] || ""}
                onChange={(e) => setAnswers(p => ({ ...p, [t.id]: e.target.value }))}
                className="flex-1 h-8 text-sm"
              />
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={() => handleDelete(t.id)}>
                <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Questionnaire section */}
      {questionTasks.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h4 className="text-sm font-semibold">📋 Dotazník ({questionTasks.length} otázek)</h4>
          {renderQuestionGroup("VYSOKÁ PRIORITA", "🔴", highPriority)}
          {renderQuestionGroup("STŘEDNÍ PRIORITA", "🟡", medPriority)}
          {renderQuestionGroup("NÍZKÁ PRIORITA", "🟢", lowPriority)}

          {answeredQuestions.length > 0 && (
            <Button onClick={handleRedistribute} disabled={isRedistributing} className="w-full gap-1.5 mt-2" size="sm">
              {isRedistributing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpFromDot className="w-4 h-4" />}
              Zapracovat {answeredQuestions.length} odpovědí do karty
            </Button>
          )}
        </div>
      )}

      {/* Client homework */}
      {homeworkTasks.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 space-y-2">
          <h4 className="text-sm font-semibold">📝 Úkoly klienta</h4>
          {homeworkTasks.map(t => (
            <div key={t.id} className="flex items-start gap-2 py-1.5">
              <button onClick={() => handleToggle(t)} className="mt-0.5 shrink-0">
                <div className="w-5 h-5 rounded border-2 border-muted-foreground/30" />
              </button>
              <span className="text-sm flex-1">{t.task}</span>
              {t.due_date && <Badge variant="outline" className="text-[10px] shrink-0">{new Date(t.due_date).toLocaleDateString("cs-CZ")}</Badge>}
            </div>
          ))}
        </div>
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

        {manualTasks.length === 0 && doneTasks.length === 0 && questionTasks.length === 0 && homeworkTasks.length === 0 && (
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
