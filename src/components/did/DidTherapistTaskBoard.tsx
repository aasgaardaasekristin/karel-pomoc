import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, MessageSquare, ChevronDown, ChevronUp, Send, Trash2, ExternalLink, ArrowUp } from "lucide-react";
import { toast } from "sonner";

interface TaskFeedbackEntry {
  id: string;
  task_id: string;
  author: string;
  message: string;
  created_at: string;
}

interface TherapistTask {
  id: string;
  task: string;
  assigned_to: string;
  status: string;
  note: string | null;
  completed_note: string | null;
  source_agreement: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  due_date: string | null;
  priority: string | null;
  category: string | null;
  status_hanka: string;
  status_kata: string;
}

type TrafficStatus = "not_started" | "in_progress" | "done";
type CategoryFilter = "all" | "today" | "tomorrow" | "longterm";
type AssigneeFilter = "all" | "hanka" | "kata" | "both";
type TherapistAssignee = "hanka" | "kata" | "both";

const TRAFFIC_COLORS: Record<TrafficStatus, string> = {
  not_started: "bg-muted border border-border",
  in_progress: "bg-accent",
  done: "bg-primary",
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
const THERAPIST_ASSIGNEES = new Set<TherapistAssignee>(["hanka", "kata", "both"]);

const stripMarkdownNoise = (text?: string | null) => (text || "")
  .replace(/^\s*[-*]\s+/gm, "")
  .replace(/\*\*/g, "")
  .replace(/\s+/g, " ")
  .trim();

const normalizeTask = (text?: string | null) => stripMarkdownNoise(text).toLowerCase();

const normalizeAssignedTo = (value?: string | null): string => (value || "").trim().toLowerCase();

const isTherapistAssignee = (value?: string | null): value is TherapistAssignee =>
  THERAPIST_ASSIGNEES.has(normalizeAssignedTo(value) as TherapistAssignee);

const assigneeLabel = (a: TherapistAssignee) => a === "hanka" ? "Hanka" : a === "kata" ? "Káťa" : "Obě";

const targetDocumentForCategory = (category?: string | null) =>
  (category === "longterm" || category === "weekly") ? "06_Strategicky_Vyhled" : "05_Operativni_Plan";

const buildTaskQueueKey = (task: { task: string; assigned_to: string; category?: string | null }) =>
  `${normalizeTask(task.task)}|${normalizeAssignedTo(task.assigned_to)}|${targetDocumentForCategory(task.category)}`;

const parsePendingWriteKey = (content?: string | null, targetDocument?: string | null) => {
  if (!content || !targetDocument) return null;
  const match = content.match(/^►\s*(.*?)\s*\[(Hanka|Káťa|Obě)\]/i);
  if (!match) return null;

  const assigned = match[2] === "Hanka" ? "hanka" : match[2] === "Káťa" ? "kata" : "both";
  return `${normalizeTask(match[1])}|${assigned}|${targetDocument}`;
};

const isAssigneeVisible = (assignedTo: TherapistAssignee, filter: AssigneeFilter) => {
  if (filter === "all") return true;
  if (filter === "both") return assignedTo === "both";
  if (filter === "hanka") return assignedTo === "hanka" || assignedTo === "both";
  return assignedTo === "kata" || assignedTo === "both";
};

const isSafeDocumentUrl = (value?: string | null) => {
  if (!value || !/^https?:\/\//i.test(value)) return null;

  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (!["docs.google.com", "drive.google.com"].includes(host)) return null;

    const path = url.pathname.toLowerCase();
    const isSearchLike = path.includes("/drive/search") || path.includes("/drive/recent") || path.includes("/drive/home");
    if (isSearchLike) return null;

    const hasDocId = /\/(document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]{20,}/.test(path)
      || /\/file\/d\/[a-zA-Z0-9_-]{20,}/.test(path)
      || /[?&]id=[a-zA-Z0-9_-]{20,}/.test(url.search);

    if (!hasDocId) return null;

    url.searchParams.delete("authuser");
    return url.toString();
  } catch {
    return null;
  }
};

const openExternalDocument = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

const isTodayCategory = (category?: string | null) => category === "today" || category === "daily";
const isTomorrowCategory = (category?: string | null) => category === "tomorrow";
const isLongtermCategory = (category?: string | null) => category === "longterm" || category === "weekly" || (!isTodayCategory(category) && !isTomorrowCategory(category));
const categoryLabel = (category?: string | null) => isTodayCategory(category) ? "Dnes" : isTomorrowCategory(category) ? "Zítra" : "Dlouhodobé";
const priorityLabel = (priority?: string | null) => priority === "high" ? "Vysoká" : priority === "normal" ? "Běžná" : "Nízká";

const aggregateTaskStatus = (task: TherapistTask): TrafficStatus => {
  if (normalizeAssignedTo(task.assigned_to) === "both") {
    if (task.status_hanka === "done" && task.status_kata === "done") return "done";
    if ([task.status_hanka, task.status_kata].includes("in_progress") || [task.status_hanka, task.status_kata].includes("done")) {
      return "in_progress";
    }
    return "not_started";
  }

  return (normalizeAssignedTo(task.assigned_to) === "hanka" ? task.status_hanka : task.status_kata || "not_started") as TrafficStatus;
};

const statusSummary = (task: TherapistTask) => {
  const assigned = normalizeAssignedTo(task.assigned_to) as TherapistAssignee;
  if (assigned === "both") {
    return `H: ${STATUS_LABEL[(task.status_hanka || "not_started") as TrafficStatus]} • K: ${STATUS_LABEL[(task.status_kata || "not_started") as TrafficStatus]}`;
  }
  return STATUS_LABEL[aggregateTaskStatus(task)];
};

const STATUS_BADGE_STYLES: Record<TrafficStatus, string> = {
  not_started: "bg-muted text-muted-foreground border-border",
  in_progress: "bg-accent/60 text-accent-foreground border-accent",
  done: "bg-primary/20 text-primary border-primary/40",
};

const STATUS_BADGE_ICON: Record<TrafficStatus, string> = {
  not_started: "—",
  in_progress: "⏳",
  done: "✓",
};

const StatusBadge = ({ status, label, onClick }: { status: TrafficStatus; label: string; onClick: () => void }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[8px] font-semibold leading-[16px] cursor-pointer transition-all hover:scale-105 ${STATUS_BADGE_STYLES[status]}`}
    title={`${label}: ${STATUS_LABEL[status]} — klikni pro změnu`}
  >
    <span>{label}:</span>
    <span>{STATUS_BADGE_ICON[status]}</span>
  </button>
);

const isAllDone = (task: TherapistTask) => {
  const assigned = normalizeAssignedTo(task.assigned_to);
  if (assigned === "hanka") return task.status_hanka === "done";
  if (assigned === "kata") return task.status_kata === "done";
  return task.status_hanka === "done" && task.status_kata === "done";
};

const TaskCard = ({
  task,
  expandedTask,
  setExpandedTask,
  noteInputs,
  setNoteInputs,
  onToggleTraffic,
  onDelete,
  onAddNote,
  isPendingDriveWrite,
  isFailedDriveWrite,
  extraActions,
}: {
  task: TherapistTask;
  expandedTask: string | null;
  setExpandedTask: (id: string | null) => void;
  noteInputs: Record<string, string>;
  setNoteInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onToggleTraffic: (task: TherapistTask, who: TherapistAssignee) => void;
  onDelete: (id: string) => void;
  onAddNote: (id: string) => void;
  isPendingDriveWrite: boolean;
  isFailedDriveWrite: boolean;
  extraActions?: React.ReactNode;
}) => {
  const isExpanded = expandedTask === task.id;
  const safeDriveLink = isSafeDocumentUrl(task.source_agreement);
  const assigned = normalizeAssignedTo(task.assigned_to) as TherapistAssignee;

  const [feedback, setFeedback] = useState<TaskFeedbackEntry[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isExpanded) return;
    const loadFeedback = async () => {
      const { data } = await supabase
        .from("did_task_feedback")
        .select("*")
        .eq("task_id", task.id)
        .order("created_at", { ascending: true });
      setFeedback((data as TaskFeedbackEntry[]) || []);
    };
    void loadFeedback();
  }, [isExpanded, task.id]);

  useEffect(() => {
    if (feedEndRef.current) feedEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [feedback.length]);

  const handleSendUpdate = async () => {
    const text = noteInputs[task.id]?.trim();
    if (!text) return;
    setSendingFeedback(true);

    // Determine author from the assigned_to or default to hanka
    const author = assigned === "kata" ? "kata" : "hanka";

    // Save therapist's message
    const { error: insertErr } = await supabase.from("did_task_feedback").insert({
      task_id: task.id,
      author,
      message: text,
    });
    if (insertErr) {
      toast.error("Nepodařilo se odeslat update");
      setSendingFeedback(false);
      return;
    }

    setNoteInputs((prev) => ({ ...prev, [task.id]: "" }));
    setFeedback((prev) => [...prev, { id: crypto.randomUUID(), task_id: task.id, author, message: text, created_at: new Date().toISOString() }]);

    // Call Karel for AI response
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-task-feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId: task.id, message: text, author }),
      });
      if (resp.ok) {
        const { reply } = await resp.json();
        setFeedback((prev) => [...prev, { id: crypto.randomUUID(), task_id: task.id, author: "karel", message: reply, created_at: new Date().toISOString() }]);
      }
    } catch (e) {
      console.warn("Karel feedback error:", e);
    }

    setSendingFeedback(false);
  };

  const authorLabel = (a: string) => a === "hanka" ? "Hanka" : a === "kata" ? "Káťa" : "Karel";
  const authorStyle = (a: string) => a === "karel"
    ? "bg-primary/10 border-primary/20 text-foreground"
    : "bg-muted/40 border-border/40 text-foreground/90";

  return (
    <div className="group rounded-md border border-border/60 bg-card/40 px-2 py-1.5 transition-colors hover:bg-accent/30">
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-0.5 shrink-0">
          {assigned === "both" ? (
            <>
              <StatusBadge status={(task.status_hanka || "not_started") as TrafficStatus} label="H" onClick={() => onToggleTraffic(task, "hanka")} />
              <StatusBadge status={(task.status_kata || "not_started") as TrafficStatus} label="K" onClick={() => onToggleTraffic(task, "kata")} />
            </>
          ) : (
            <StatusBadge
              status={aggregateTaskStatus(task)}
              label={assigned === "hanka" ? "H" : "K"}
              onClick={() => onToggleTraffic(task, assigned)}
            />
          )}
        </div>

        <button className="flex-1 min-w-0 text-left" onClick={() => setExpandedTask(isExpanded ? null : task.id)}>
          {isExpanded ? (
            <span className="text-[11px] font-medium text-foreground leading-tight">{stripMarkdownNoise(task.task)}</span>
          ) : (
            <span className="text-[11px] text-foreground leading-tight truncate block">{stripMarkdownNoise(task.task)}</span>
          )}
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
        <div className="mt-1.5 space-y-1.5 border-t border-border/30 pt-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
            <span>👤 {assigneeLabel(assigned)}</span>
            <span>🗂️ {categoryLabel(task.category)}</span>
            <span>⚡ {priorityLabel(task.priority)}</span>
            <span>📍 {statusSummary(task)}</span>
            {task.due_date && <span>📅 {new Date(task.due_date).toLocaleDateString("cs-CZ")}</span>}
          </div>

          {/* Full detailed instruction: merged task + note */}
          {(() => {
            const fullInstruction = [stripMarkdownNoise(task.task), stripMarkdownNoise(task.note)].filter(Boolean).join("\n\n");
            return fullInstruction ? (
              <div className="rounded bg-muted/30 px-2 py-1.5">
                <p className="text-[10px] leading-relaxed text-foreground/80 whitespace-pre-line">
                  {fullInstruction}
                </p>
              </div>
            ) : null;
          })()}

          {isPendingDriveWrite && (
            <div className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-1 text-[9px] text-muted-foreground">
              🆕 Nový úkol — čeká na propsání do kartotéky.
            </div>
          )}

          {isFailedDriveWrite && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-1 text-[9px] text-destructive">
              ⚠️ Poslední propsání do kartotéky selhalo. Zkus znovu aktualizaci.
            </div>
          )}

          {task.source_agreement && (
            <div className="flex items-center gap-1">
              <span className="max-w-[220px] truncate text-[9px] text-muted-foreground">📋 {stripMarkdownNoise(task.source_agreement)}</span>
              {safeDriveLink && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); openExternalDocument(safeDriveLink); }}
                  className="inline-flex items-center gap-0.5 shrink-0 text-[9px] text-primary hover:underline"
                >
                  <ExternalLink className="w-2.5 h-2.5" /> Otevřít
                </button>
              )}
            </div>
          )}

          {/* Feedback feed */}
          {feedback.length > 0 && (
            <div className="space-y-1 max-h-[160px] overflow-y-auto rounded bg-background/50 p-1">
              {feedback.map((entry) => (
                <div key={entry.id} className={`rounded border px-1.5 py-1 ${authorStyle(entry.author)}`}>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[8px] font-semibold">{entry.author === "karel" ? "🤖" : "💬"} {authorLabel(entry.author)}</span>
                    <span className="text-[7px] text-muted-foreground">{new Date(entry.created_at).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p className="text-[9px] leading-relaxed whitespace-pre-line mt-0.5">{entry.message}</p>
                </div>
              ))}
              <div ref={feedEndRef} />
            </div>
          )}

          {/* Legacy completed_note display */}
          {task.completed_note && feedback.length === 0 && (
            <div className="whitespace-pre-line rounded bg-muted/40 px-1.5 py-1 text-[9px] text-muted-foreground">
              <MessageSquare className="mr-0.5 inline h-2.5 w-2.5 opacity-60" />
              {task.completed_note}
            </div>
          )}

          <div className="flex gap-1">
            <Input
              value={noteInputs[task.id] || ""}
              onChange={(e) => setNoteInputs((prev) => ({ ...prev, [task.id]: e.target.value }))}
              placeholder="Jak to jde? Napiš update..."
              className="h-6 flex-1 bg-background text-[9px]"
              onKeyDown={(e) => { if (e.key === "Enter") void handleSendUpdate(); }}
            />
            <Button size="sm" onClick={() => void handleSendUpdate()} className="h-6 w-6 p-0" disabled={!noteInputs[task.id]?.trim() || sendingFeedback}>
              {sendingFeedback ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Send className="w-2.5 h-2.5" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const SectionHeader = ({ emoji, label, count, max }: { emoji: string; label: string; count: number; max?: number }) => (
  <div className="mb-1 flex items-center justify-between">
    <span className="text-[10px] font-semibold text-foreground">{emoji} {label}</span>
    {max !== undefined && <span className="text-[8px] text-muted-foreground">{count}/{max}</span>}
  </div>
);

const DidTherapistTaskBoard = ({ refreshTrigger = 0 }: { refreshTrigger?: number }) => {
  const [tasks, setTasks] = useState<TherapistTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTask, setNewTask] = useState("");
  const [newAssignee, setNewAssignee] = useState<TherapistAssignee>("both");
  const [newCategory, setNewCategory] = useState<"today" | "tomorrow" | "longterm">("today");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("today");
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("hanka");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [pendingTaskKeys, setPendingTaskKeys] = useState<Set<string>>(new Set());
  const [failedTaskKeys, setFailedTaskKeys] = useState<Set<string>>(new Set());
  const [trafficLock, setTrafficLock] = useState(false);

  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const loadTasks = useCallback(async () => {
    const [{ data, error }, { data: queueRows }] = await Promise.all([
      supabase
        .from("did_therapist_tasks")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("did_pending_drive_writes")
        .select("content, target_document, status")
        .in("status", ["pending", "failed"])
        .order("created_at", { ascending: false })
        .limit(250),
    ]);

    const pendingSet = new Set<string>();
    const failedSet = new Set<string>();
    for (const row of queueRows || []) {
      const key = parsePendingWriteKey(row.content, row.target_document);
      if (!key) continue;
      if (row.status === "pending") pendingSet.add(key);
      if (row.status === "failed") failedSet.add(key);
    }
    setPendingTaskKeys(pendingSet);
    setFailedTaskKeys(failedSet);

    if (!error && data) {
      const now = Date.now();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const normalizedRows = (data as TherapistTask[])
        .map((task) => ({ ...task, assigned_to: normalizeAssignedTo(task.assigned_to) }))
        .filter((task) => isTherapistAssignee(task.assigned_to));

      const toArchive = normalizedRows.filter((task) =>
        isAllDone(task) && task.completed_at && (now - new Date(task.completed_at).getTime()) > threeDays
      );
      if (toArchive.length > 0) {
        await supabase.from("did_therapist_tasks").delete().in("id", toArchive.map((task) => task.id));
      }

      const toEscalate = normalizedRows.filter((task) =>
        !isAllDone(task) && task.priority !== "high" && (now - new Date(task.created_at).getTime()) > sevenDays
      );
      if (toEscalate.length > 0) {
        await supabase.from("did_therapist_tasks").update({ priority: "high" }).in("id", toEscalate.map((task) => task.id));
      }

      if (toArchive.length > 0 || toEscalate.length > 0) {
        const { data: fresh } = await supabase.from("did_therapist_tasks").select("*").order("created_at", { ascending: false });
        const freshTasks = ((fresh || []) as TherapistTask[])
          .map((task) => ({ ...task, assigned_to: normalizeAssignedTo(task.assigned_to) }))
          .filter((task) => isTherapistAssignee(task.assigned_to));
        setTasks(freshTasks);
      } else {
        setTasks(normalizedRows);
      }
    }

    setLoading(false);
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);
  useEffect(() => { if (refreshTrigger > 0) void loadTasks(); }, [refreshTrigger, loadTasks]);

  const handleAddTask = async () => {
    if (!newTask.trim()) return;
    setAdding(true);

    const taskText = stripMarkdownNoise(newTask);
    const targetDoc = targetDocumentForCategory(newCategory);
    const sourceReference = `00_CENTRUM/${targetDoc} · sekce „Nové úkoly z nástěnky“`;

    const { error } = await supabase.from("did_therapist_tasks").insert({
      task: taskText,
      assigned_to: newAssignee,
      category: newCategory,
      source_agreement: sourceReference,
      status_hanka: "not_started",
      status_kata: "not_started",
      priority: newCategory === "today" ? "high" : newCategory === "tomorrow" ? "normal" : "low",
    });

    if (error) {
      toast.error("Nepodařilo se přidat úkol");
    } else {
      await supabase.from("did_pending_drive_writes").insert({
        content: `► ${taskText} [${assigneeLabel(newAssignee)}]`,
        target_document: targetDoc,
        write_type: "append",
        priority: newCategory === "today" ? "high" : "normal",
      }).then(({ error: writeErr }) => {
        if (writeErr) console.warn("Pending write queue error:", writeErr);
      });

      setNewTask("");
      void loadTasks();
    }

    setAdding(false);
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

        let style = existing.preferred_style || "balanced";
        if (completed > 5) {
          const ratio = completed / Math.max(1, completed + missed);
          if (ratio > 0.8) style = "praise";
          else if (avgDays > 4) style = "deadline";
          else style = "instruction";
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

  const handleToggleTraffic = async (taskArg: TherapistTask, who: TherapistAssignee) => {
    if (trafficLock) return;
    setTrafficLock(true);

    const freshTask = tasksRef.current.find((task) => task.id === taskArg.id);
    if (!freshTask) {
      setTrafficLock(false);
      return;
    }

    const updates: Record<string, string | null> = { updated_at: new Date().toISOString() };
    let bothDone = false;

    if (who === "both") {
      const current = aggregateTaskStatus(freshTask);
      const next = NEXT_STATUS[current];
      updates.status_hanka = next;
      updates.status_kata = next;
      bothDone = next === "done";
    } else {
      const field = who === "hanka" ? "status_hanka" : "status_kata";
      const current = (freshTask[field] || "not_started") as TrafficStatus;
      const next = NEXT_STATUS[current];
      updates[field] = next;

      const otherField = who === "hanka" ? "status_kata" : "status_hanka";
      const otherStatus = (freshTask[otherField] || "not_started") as TrafficStatus;
      bothDone = next === "done" && (normalizeAssignedTo(freshTask.assigned_to) !== "both" || otherStatus === "done");
    }

    if (bothDone) {
      updates.status = "done";
      updates.completed_at = new Date().toISOString();
    } else {
      updates.status = "pending";
      updates.completed_at = null;
    }

    setTasks((prev) => prev.map((task) => task.id === freshTask.id ? { ...task, ...updates } as TherapistTask : task));

    const { error } = await supabase.from("did_therapist_tasks").update(updates).eq("id", freshTask.id);
    if (error) {
      toast.error("Nepodařilo se změnit stav");
      await loadTasks();
      setTrafficLock(false);
      return;
    }

    if (bothDone) {
      const assigned = normalizeAssignedTo(freshTask.assigned_to);
      if (assigned === "both" || who === "both") {
        void updateMotivationProfile("Hanka", "completed", freshTask.created_at);
        void updateMotivationProfile("Káťa", "completed", freshTask.created_at);
      } else {
        void updateMotivationProfile(who === "hanka" ? "Hanka" : "Káťa", "completed", freshTask.created_at);
      }
    }

    setTrafficLock(false);
  };

  const handleDelete = async (taskId: string) => {
    await supabase.from("did_therapist_tasks").delete().eq("id", taskId);
    await loadTasks();
    toast.success("Úkol odstraněn");
  };

  const handleAddNote = async (taskId: string) => {
    const note = noteInputs[taskId]?.trim();
    if (!note) return;
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const existingNote = task.completed_note || "";
    const dateStr = new Date().toLocaleDateString("cs-CZ");
    const updatedNote = existingNote ? `${existingNote}\n[${dateStr}] ${note}` : `[${dateStr}] ${note}`;
    await supabase.from("did_therapist_tasks").update({ completed_note: updatedNote, updated_at: new Date().toISOString() }).eq("id", taskId);
    setNoteInputs((prev) => ({ ...prev, [taskId]: "" }));
    await loadTasks();
    toast.success("Poznámka přidána");
  };

  const handlePromote = async (taskId: string, to: "today" | "tomorrow") => {
    await supabase.from("did_therapist_tasks").update({
      category: to,
      priority: to === "today" ? "high" : "normal",
      updated_at: new Date().toISOString(),
    }).eq("id", taskId);
    await loadTasks();
    toast.success(`Úkol přesunut do ${to === "today" ? "DNES" : "ZÍTRA"}`);
  };

  const matchesCategoryFilter = (task: TherapistTask) => {
    if (categoryFilter === "all") return true;
    if (categoryFilter === "today") return isTodayCategory(task.category);
    if (categoryFilter === "tomorrow") return isTomorrowCategory(task.category);
    return isLongtermCategory(task.category);
  };

  const isPendingForTask = (task: TherapistTask) => pendingTaskKeys.has(buildTaskQueueKey(task));
  const isFailedForTask = (task: TherapistTask) => failedTaskKeys.has(buildTaskQueueKey(task));

  const active = tasks.filter((task) => !isAllDone(task));
  const done = tasks.filter((task) => isAllDone(task));

  const visibleActive = active.filter((task) => matchesCategoryFilter(task) && isAssigneeVisible(normalizeAssignedTo(task.assigned_to) as TherapistAssignee, assigneeFilter));
  const visibleDone = done.filter((task) => matchesCategoryFilter(task) && isAssigneeVisible(normalizeAssignedTo(task.assigned_to) as TherapistAssignee, assigneeFilter));

  const todayTasks = visibleActive.filter((task) => isTodayCategory(task.category));
  const tomorrowTasks = visibleActive.filter((task) => isTomorrowCategory(task.category));
  const longtermTasks = visibleActive.filter((task) => isLongtermCategory(task.category));
  const generalActive = longtermTasks.filter((task) => task.category === "general" || !task.category);
  const longtermList = longtermTasks.filter((task) => task.category === "longterm" || task.category === "weekly");

  const showToday = categoryFilter === "all" || categoryFilter === "today";
  const showTomorrow = categoryFilter === "all" || categoryFilter === "tomorrow";
  const showLongterm = categoryFilter === "all" || categoryFilter === "longterm";

  const sharedProps = {
    expandedTask,
    setExpandedTask,
    noteInputs,
    setNoteInputs,
    onToggleTraffic: handleToggleTraffic,
    onDelete: handleDelete,
    onAddNote: handleAddNote,
  };

  if (loading) {
    return <div className="flex items-center justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5 rounded-md border border-border/60 bg-card/40 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            placeholder="Nový konkrétní úkol..."
            className="h-7 flex-1 bg-background text-[11px]"
            onKeyDown={(e) => { if (e.key === "Enter") void handleAddTask(); }}
          />
          <Button size="sm" onClick={() => void handleAddTask()} disabled={!newTask.trim() || adding} className="h-7 w-7 p-0">
            {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          </Button>
        </div>

        <div className="space-y-1.5 rounded-md border border-border/60 bg-background/70 p-1.5">
          <div>
            <p className="mb-1 text-[8px] text-muted-foreground">Kdo</p>
            <div className="flex flex-wrap gap-1">
              {(["hanka", "kata", "both"] as const).map((assignee) => (
                <Button
                  key={assignee}
                  variant={assigneeFilter === assignee ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setAssigneeFilter(assignee); setNewAssignee(assignee); }}
                  className="h-5 min-w-0 rounded-full px-2.5 text-[8px]"
                >
                  {assigneeLabel(assignee)}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[8px] text-muted-foreground">Kdy</p>
            <div className="flex flex-wrap gap-1">
              {(["today", "tomorrow", "longterm"] as const).map((category) => (
                <Button
                  key={category}
                  variant={categoryFilter === category ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setCategoryFilter(category); setNewCategory(category); }}
                  className="h-5 min-w-0 rounded-full px-2.5 text-[8px]"
                >
                  {category === "today" ? "Dnes" : category === "tomorrow" ? "Zítra" : "Dlouhodobé"}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showToday && todayTasks.length > 0 && (
        <div>
          <SectionHeader emoji="🔴" label="DNES" count={todayTasks.length} max={MAX_TODAY} />
          <div className="space-y-1">
            {todayTasks.slice(0, MAX_TODAY).map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                {...sharedProps}
                isPendingDriveWrite={isPendingForTask(task)}
                isFailedDriveWrite={isFailedForTask(task)}
              />
            ))}
            {todayTasks.length > MAX_TODAY && <p className="text-center text-[8px] text-muted-foreground">+{todayTasks.length - MAX_TODAY} dalších</p>}
          </div>
        </div>
      )}

      {showTomorrow && tomorrowTasks.length > 0 && (
        <div>
          <SectionHeader emoji="🟡" label="ZÍTRA" count={tomorrowTasks.length} max={MAX_TOMORROW} />
          <div className="space-y-1">
            {tomorrowTasks.slice(0, MAX_TOMORROW).map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                {...sharedProps}
                isPendingDriveWrite={isPendingForTask(task)}
                isFailedDriveWrite={isFailedForTask(task)}
              />
            ))}
            {tomorrowTasks.length > MAX_TOMORROW && <p className="text-center text-[8px] text-muted-foreground">+{tomorrowTasks.length - MAX_TOMORROW} dalších</p>}
          </div>
        </div>
      )}

      {showLongterm && generalActive.length > 0 && (
        <div>
          <SectionHeader emoji="📌" label="Aktivní úkoly" count={generalActive.length} />
          <div className="space-y-1">
            {generalActive.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                {...sharedProps}
                isPendingDriveWrite={isPendingForTask(task)}
                isFailedDriveWrite={isFailedForTask(task)}
              />
            ))}
          </div>
        </div>
      )}

      {showLongterm && longtermList.length > 0 && (
        <div>
          <SectionHeader emoji="📋" label="Dlouhodobé" count={longtermList.length} max={MAX_LONGTERM} />
          <div className="space-y-1">
            {longtermList.slice(0, MAX_LONGTERM).map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                {...sharedProps}
                isPendingDriveWrite={isPendingForTask(task)}
                isFailedDriveWrite={isFailedForTask(task)}
                extraActions={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); void handlePromote(task.id, "today"); }}
                    className="h-5 w-5 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Povýšit na DNES"
                  >
                    <ArrowUp className="w-2.5 h-2.5 text-primary" />
                  </Button>
                }
              />
            ))}
            {longtermList.length > MAX_LONGTERM && <p className="pt-1 text-center text-[8px] text-muted-foreground">+{longtermList.length - MAX_LONGTERM} dalších</p>}
          </div>
        </div>
      )}

      {active.length === 0 && done.length === 0 && (
        <p className="py-3 text-center text-[10px] text-muted-foreground">Zatím žádné terapeutické úkoly.</p>
      )}

      {active.length > 0 && visibleActive.length === 0 && (
        <p className="py-2 text-center text-[10px] text-muted-foreground">Pro zvolený filtr tu teď nic není.</p>
      )}

      {visibleDone.length > 0 && (
        <details className="group/done">
          <summary className="cursor-pointer select-none text-[9px] text-muted-foreground transition-colors hover:text-foreground">
            ✅ Splněné ({visibleDone.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {visibleDone.slice(0, 10).map((task) => (
              <div key={task.id} className="flex items-center gap-1.5 rounded bg-muted/20 px-2 py-1 opacity-50">
                <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                <span className="flex-1 truncate text-[10px] text-muted-foreground line-through">{stripMarkdownNoise(task.task)}</span>
                <Button variant="ghost" size="sm" onClick={() => void handleDelete(task.id)} className="h-4 w-4 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/done:opacity-100">
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
