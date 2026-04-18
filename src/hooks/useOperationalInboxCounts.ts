import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import {
  OPEN_QUESTION_STATUSES,
  PENDING_QUESTIONS_CHANGED_EVENT,
} from "@/lib/pendingQuestionStatuses";

export interface OpsSnapshot {
  pendingQuestions: number;
  pendingWrites: number;
  urgentTasks: number;
  overdueTasks: number;
  livePlans: number;
  staleTasks: number;
}

// BUGFIX (counter sanity): hard cap on every counter so a runaway query (e.g.
// a regression that strips status filtering and returns every row in the table)
// can never render "1247 urgentních" in the dashboard. We surface 99+ as the
// max — anything beyond that is a bug, not a real operational state.
const HARD_COUNT_CAP = 99;
const STALE_TASK_THRESHOLD_DAYS = 7;

function capCount(n: number | null | undefined): number {
  if (!n || n <= 0) return 0;
  return n > HARD_COUNT_CAP ? HARD_COUNT_CAP : n;
}

export function useOperationalInboxCounts(refreshTrigger: number) {
  const [counts, setCounts] = useState<OpsSnapshot>({
    pendingQuestions: 0,
    pendingWrites: 0,
    urgentTasks: 0,
    overdueTasks: 0,
    livePlans: 0,
    staleTasks: 0,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const todayISO = pragueTodayISO();
      // Tasks created BEFORE this cutoff and still in an open status are
      // reclassified as "stale / archive candidate" — we expose them as a
      // separate counter so the briefing surface can frame them as such
      // instead of letting them inflate the urgent / overdue figures forever.
      const staleCutoffISO = new Date(
        Date.now() - STALE_TASK_THRESHOLD_DAYS * 86400000,
      ).toISOString();

      const [qRes, wRes, urgentRes, overdueRes, pRes, staleRes] = await Promise.all([
        supabase
          .from("did_pending_questions")
          .select("id", { count: "exact", head: true })
          .in("status", OPEN_QUESTION_STATUSES as unknown as string[]),
        supabase
          .from("did_pending_drive_writes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        // Urgent: high priority AND created within the stale window. A
        // forgotten "urgent" task from 3 weeks ago is no longer urgent —
        // it is stale and belongs in its own counter.
        supabase
          .from("did_therapist_tasks")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "active", "in_progress"] as any)
          .in("priority", ["critical", "urgent", "high"] as any)
          .gte("created_at", staleCutoffISO),
        supabase
          .from("did_therapist_tasks")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "active", "in_progress"] as any)
          .not("due_date", "is", null)
          .lt("due_date", todayISO)
          .gte("created_at", staleCutoffISO),
        supabase
          .from("did_daily_session_plans")
          .select("id", { count: "exact", head: true })
          .in("status", ["generated", "in_progress"]),
        // Stale / archive-candidate: open tasks older than the threshold.
        // Surfaced as a separate (calmer) counter — never red.
        supabase
          .from("did_therapist_tasks")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "active", "in_progress"] as any)
          .lt("created_at", staleCutoffISO),
      ]);

      if (cancelled) return;

      setCounts({
        pendingQuestions: capCount(qRes.count),
        pendingWrites: capCount(wRes.count),
        urgentTasks: capCount(urgentRes.count),
        overdueTasks: capCount(overdueRes.count),
        livePlans: capCount(pRes.count),
        staleTasks: capCount(staleRes.count),
      });
    }

    load();
    const id = window.setInterval(load, 30000);

    // Immediate recount when a pending question is answered/mutated anywhere
    // in the app — keeps DidSprava badge and dashboard snapshot in sync
    // without waiting for the 30s polling tick.
    const onChanged = () => {
      load();
    };
    window.addEventListener(PENDING_QUESTIONS_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener(PENDING_QUESTIONS_CHANGED_EVENT, onChanged);
    };
  }, [refreshTrigger]);

  return counts;
}
