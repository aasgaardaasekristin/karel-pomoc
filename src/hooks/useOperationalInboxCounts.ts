import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getDueDateFlags } from "@/lib/dateOnlyTaskHelpers";

export interface OpsSnapshot {
  pendingQuestions: number;
  pendingWrites: number;
  urgentTasks: number;
  overdueTasks: number;
  livePlans: number;
}

export function useOperationalInboxCounts(refreshTrigger: number) {
  const [counts, setCounts] = useState<OpsSnapshot>({
    pendingQuestions: 0,
    pendingWrites: 0,
    urgentTasks: 0,
    overdueTasks: 0,
    livePlans: 0,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [qRes, wRes, tRes, pRes] = await Promise.all([
        supabase
          .from("did_pending_questions")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "sent", "open"]),
        supabase
          .from("did_pending_drive_writes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        supabase
          .from("did_therapist_tasks")
          .select("id, priority, due_date, status")
          .in("status", ["pending", "active", "in_progress"] as any),
        supabase
          .from("did_daily_session_plans")
          .select("id", { count: "exact", head: true })
          .in("status", ["generated", "in_progress"]),
      ]);

      if (cancelled) return;

      const tasks = (tRes.data as any[]) || [];
      const now = Date.now();
      const urgentTasks = tasks.filter(
        (t) => t.priority === "critical" || t.priority === "urgent" || t.priority === "high"
      ).length;
      const overdueTasks = tasks.filter(
        (t) => getDueDateFlags(t.due_date).overdue
      ).length;

      setCounts({
        pendingQuestions: qRes.count ?? 0,
        pendingWrites: wRes.count ?? 0,
        urgentTasks,
        overdueTasks,
        livePlans: pRes.count ?? 0,
      });
    }

    load();
    const id = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshTrigger]);

  return counts;
}
