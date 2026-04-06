import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, HelpCircle, ListChecks, Calendar, Clock } from "lucide-react";

interface Props {
  refreshTrigger: number;
}

interface CrisisJournalEntry {
  crisis_trend: string | null;
  karel_action: string | null;
  session_summary: string | null;
  part_id: string | null;
  date: string | null;
}

interface PendingTask {
  id: string;
  task: string;
  assigned_to: string;
  priority: string | null;
}

interface PendingQuestion {
  id: string;
  question: string;
  directed_to: string;
}

interface SessionPlan {
  id: string;
  selected_part: string;
  therapist: string;
  session_format: string;
  status: string;
}

interface Commitment {
  id: string;
  commitment_text: string;
  due_date: string;
  committed_by: string;
}

const assigneeLabel = (a: string) => {
  const l = (a || "").toLowerCase();
  if (l === "hanka" || l === "hanička") return "Hanka";
  if (l === "kata" || l === "káťa") return "Káťa";
  if (l === "karel") return "Karel";
  return "Obě";
};

const KarelDailyPlan = ({ refreshTrigger }: Props) => {
  const [crisisJournal, setCrisisJournal] = useState<CrisisJournalEntry | null>(null);
  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);
  const [crisisDays, setCrisisDays] = useState<number | null>(null);
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [sessions, setSessions] = useState<SessionPlan[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);

      const [tasksRes, questionsRes, sessionsRes, commitmentsRes, crisisRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, priority")
          .in("status", ["pending", "active", "in_progress"])
          .order("priority", { ascending: true })
          .limit(10),
        (supabase as any)
          .from("did_pending_questions")
          .select("id, question, directed_to")
          .in("status", ["pending", "sent"])
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("did_daily_session_plans")
          .select("id, selected_part, therapist, session_format, status")
          .in("status", ["planned", "in_progress"])
          .gte("plan_date", today)
          .order("urgency_score", { ascending: false })
          .limit(5),
        (supabase as any)
          .from("karel_commitments")
          .select("id, commitment_text, due_date, committed_by")
          .eq("status", "open")
          .lte("due_date", today)
          .order("due_date", { ascending: true })
          .limit(10),
        supabase
          .from("crisis_alerts")
          .select("id, part_name, days_in_crisis")
          .neq("status", "resolved")
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      setTasks(tasksRes.data || []);
      setQuestions(questionsRes.data || []);
      setSessions(sessionsRes.data || []);
      setCommitments(commitmentsRes.data || []);

      // Load crisis journal for the active crisis
      const activeCrisis = crisisRes.data?.[0];
      if (activeCrisis) {
        setCrisisPartName(activeCrisis.part_name);
        setCrisisDays(activeCrisis.days_in_crisis);
        const { data: journal } = await (supabase as any)
          .from("crisis_journal")
          .select("crisis_trend, karel_action, session_summary, part_id, date")
          .eq("crisis_alert_id", activeCrisis.id)
          .order("date", { ascending: false })
          .limit(1);
        setCrisisJournal(journal?.[0] || null);
      } else {
        setCrisisPartName(null);
        setCrisisDays(null);
        setCrisisJournal(null);
      }
    } catch (err) {
      console.error("[KarelDailyPlan] Load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-3 animate-pulse">
        <div className="h-4 w-40 bg-muted rounded mb-2" />
        <div className="h-3 w-full bg-muted rounded" />
      </div>
    );
  }

  const hasAnything = crisisPartName || questions.length > 0 || tasks.length > 0 || sessions.length > 0 || commitments.length > 0;
  if (!hasAnything) return null;

  const overdueCommitments = commitments.filter(c => {
    const daysOverdue = Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000);
    return daysOverdue > 0;
  });

  return (
    <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm p-3 space-y-2.5">
      <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5">
        📋 Karlův denní plán
      </h3>

      {/* Crisis summary */}
      {crisisPartName && (
        <div className="flex items-start gap-2 text-xs">
          <span className="text-destructive font-bold shrink-0">🔴 KRIZE:</span>
          <div className="text-foreground">
            <span className="font-semibold">{crisisPartName}</span>
            {crisisDays != null && <span className="text-muted-foreground"> — den {crisisDays}</span>}
            {crisisJournal && (
              <span className="text-muted-foreground">
                {crisisJournal.crisis_trend && `, trend: ${crisisJournal.crisis_trend}`}
              </span>
            )}
            {crisisJournal && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {crisisJournal.karel_action && `Karel: ${crisisJournal.karel_action}`}
                {crisisJournal.session_summary && ` | Sezení: ${crisisJournal.session_summary}`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Pending questions */}
      {questions.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <HelpCircle className="w-3 h-3 text-amber-500" />
            ❓ KAREL SE PTÁ ({questions.length}):
          </div>
          {questions.slice(0, 5).map(q => (
            <p key={q.id} className="text-[10px] text-muted-foreground pl-5 leading-relaxed">
              • {q.question.slice(0, 150)}{q.question.length > 150 ? "…" : ""}
              <span className="text-[9px] ml-1 opacity-60">({q.directed_to})</span>
            </p>
          ))}
        </div>
      )}

      {/* Today tasks */}
      {tasks.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <ListChecks className="w-3 h-3 text-primary" />
            📝 ÚKOLY DNES ({tasks.length}):
          </div>
          {tasks.slice(0, 5).map(t => (
            <p key={t.id} className="text-[10px] text-muted-foreground pl-5">
              • <span className="font-medium text-foreground/80">{assigneeLabel(t.assigned_to)}</span>: {t.task.slice(0, 120)}
            </p>
          ))}
        </div>
      )}

      {/* Sessions today */}
      <div className="text-xs space-y-1">
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <Calendar className="w-3 h-3 text-primary" />
          🎯 SEZENÍ DNES:
        </div>
        {sessions.length > 0 ? (
          sessions.map(s => (
            <p key={s.id} className="text-[10px] text-muted-foreground pl-5">
              • {s.selected_part} — {s.therapist}, {s.session_format} ({s.status})
            </p>
          ))
        ) : (
          <p className="text-[10px] text-muted-foreground pl-5 italic">žádné</p>
        )}
      </div>

      {/* Overdue commitments */}
      {overdueCommitments.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            ⚠️ NESPLNĚNÉ ZÁVAZKY ({overdueCommitments.length}):
          </div>
          {overdueCommitments.map(c => {
            const daysOverdue = Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000);
            return (
              <p key={c.id} className="text-[10px] text-muted-foreground pl-5">
                • {c.commitment_text.slice(0, 120)} — <span className="text-amber-600 dark:text-amber-400 font-medium">{daysOverdue} dní po termínu</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default KarelDailyPlan;
