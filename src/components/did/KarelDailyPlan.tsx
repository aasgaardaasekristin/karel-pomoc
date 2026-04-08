import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

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
  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);
  const [crisisDays, setCrisisDays] = useState<number | null>(null);
  const [crisisJournal, setCrisisJournal] = useState<CrisisJournalEntry | null>(null);
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
      <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5">
        <div className="h-5 w-48 bg-gray-100 rounded mb-3 animate-pulse" />
        <div className="h-4 w-full bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  const hasAnything = crisisPartName || questions.length > 0 || tasks.length > 0 || sessions.length > 0 || commitments.length > 0;
  if (!hasAnything) return null;

  const overdueCommitments = commitments.filter(c => {
    const daysOverdue = Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000);
    return daysOverdue > 0;
  });

  const todayFormatted = new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-5 space-y-5">
      <h2 className="text-[20px] font-semibold" style={{ color: "#2D2D2D" }}>
        📋 Karlův denní plán — {todayFormatted}
      </h2>

      {/* Crisis */}
      {crisisPartName && (
        <div className="space-y-1">
          <h3 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: "#7C2D2D" }}>
            🔴 Krize
          </h3>
          <div className="text-[14px]" style={{ color: "#4A4A4A" }}>
            <span className="font-semibold">{crisisPartName}</span>
            {crisisDays != null && <span className="text-[12px] ml-1 opacity-70">— den {crisisDays}</span>}
            {crisisJournal?.crisis_trend && (
              <span className="text-[12px] ml-2 opacity-70">trend: {crisisJournal.crisis_trend}</span>
            )}
          </div>
          {crisisJournal && (crisisJournal.karel_action || crisisJournal.session_summary) && (
            <p className="text-[12px]" style={{ color: "#4A4A4A" }}>
              {crisisJournal.karel_action && `Karel: ${crisisJournal.karel_action}`}
              {crisisJournal.karel_action && crisisJournal.session_summary && " | "}
              {crisisJournal.session_summary && `Sezení: ${crisisJournal.session_summary}`}
            </p>
          )}
          <hr className="border-gray-100 mt-3" />
        </div>
      )}

      {/* Pending questions */}
      {questions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: "#2D2D2D" }}>
            ❓ Karel se ptá ({questions.length})
          </h3>
          {questions.slice(0, 5).map(q => (
            <p key={q.id} className="text-[14px] pl-5 leading-relaxed" style={{ color: "#4A4A4A" }}>
              • {q.question.slice(0, 200)}{q.question.length > 200 ? "…" : ""}
              <span className="text-[12px] ml-1 opacity-50">({q.directed_to})</span>
            </p>
          ))}
          <hr className="border-gray-100 mt-1" />
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: "#2D2D2D" }}>
            📝 Úkoly dnes ({tasks.length})
          </h3>
          {tasks.slice(0, 5).map(t => (
            <p key={t.id} className="text-[14px] pl-5" style={{ color: "#4A4A4A" }}>
              • <span className="font-medium">{assigneeLabel(t.assigned_to)}</span>: {t.task.slice(0, 150)}
            </p>
          ))}
          <hr className="border-gray-100 mt-1" />
        </div>
      )}

      {/* Sessions */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: "#2D2D2D" }}>
            🎯 Sezení dnes
          </h3>
          {sessions.map(s => (
            <p key={s.id} className="text-[14px] pl-5" style={{ color: "#4A4A4A" }}>
              • {s.selected_part} — {s.therapist}, {s.session_format}
            </p>
          ))}
          <hr className="border-gray-100 mt-1" />
        </div>
      )}

      {/* Overdue commitments */}
      {overdueCommitments.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: "#B45309" }}>
            ⚠️ Nesplněné závazky ({overdueCommitments.length})
          </h3>
          {overdueCommitments.map(c => {
            const daysOverdue = Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000);
            return (
              <p key={c.id} className="text-[14px] pl-5" style={{ color: "#4A4A4A" }}>
                • {c.commitment_text.slice(0, 150)} — <span style={{ color: "#B45309" }} className="font-medium">{daysOverdue} dní po termínu</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default KarelDailyPlan;
