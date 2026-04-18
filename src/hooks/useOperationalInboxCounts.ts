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

// SCOPE GUARANTEE (counter sanity, root-cause level):
//
// Per-user isolation for these counters is enforced at the DATABASE LEVEL via RLS,
// not at the query level. Verified policies (cmd=SELECT, qual=auth.uid()=user_id):
//   - did_therapist_tasks         → "Users can read own therapist tasks"
//   - did_daily_session_plans     → "Users can read own plans"
//   - did_pending_drive_writes    → "Users can read own pending writes"
//
// `did_pending_questions` intentionally has SELECT qual=true: this table is a
// SHARED inbox between the two therapists (Hanka + Káťa), it has no `user_id`
// column and acts as a single-tenant operational queue for the practice. So no
// per-user filter is meaningful or possible — the count reflects the practice's
// real shared question backlog.
//
// Therefore NO additional `.eq("user_id", uid)` filter is needed at the query
// level — adding one would be redundant for the RLS-protected tables and
// impossible for the shared questions table.
//
// HARD_COUNT_CAP exists as a defense-in-depth safeguard, NOT as a substitute
// for proper scoping: if a future regression strips status/priority filters
// and a single user genuinely accumulates > 99 open tasks, the cap surfaces
// "99+" so the UI never renders absurd counts like "1247 urgentních" without
// us noticing the underlying bug.
const HARD_COUNT_CAP = 99;
const STALE_TASK_THRESHOLD_DAYS = 7;
// Visible-surface ceiling: KarelDailyPlan only loads tasks created within
// the last 14 days. Counters MUST NOT count anything older than that ceiling
// — otherwise the dashboard advertises "K archivaci: N" while none of those
// N tasks are reachable in any task surface. The visible-surface ceiling and
// the counter ceiling are deliberately the same constant so the two can
// never drift apart again.
const VISIBLE_TASK_WINDOW_DAYS = 14;

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
      // Anything older than the visible-surface ceiling is invisible in the
      // briefing and therefore must not be counted. This is the SAME 14-day
      // window used by KarelDailyPlan's task query — see comment on
      // VISIBLE_TASK_WINDOW_DAYS above.
      const visibleFloorISO = new Date(
        Date.now() - VISIBLE_TASK_WINDOW_DAYS * 86400000,
      ).toISOString();

      // STATUS FILTER NOTE (audited against production DB):
      //   did_therapist_tasks only ever uses `pending` / `expired` / `archived`.
      //   `active` and `in_progress` were aspirational status values that
      //   never landed in the write path — counting them was a no-op that
      //   made the audit trail lie about what we measure. Open work = `pending`.
      const OPEN_TASK_STATUSES = ["pending"] as any;

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
          .in("status", OPEN_TASK_STATUSES)
          .in("priority", ["critical", "urgent", "high"] as any)
          .gte("created_at", staleCutoffISO),
        supabase
          .from("did_therapist_tasks")
          .select("id", { count: "exact", head: true })
          .in("status", OPEN_TASK_STATUSES)
          .not("due_date", "is", null)
          .lt("due_date", todayISO)
          .gte("created_at", staleCutoffISO),
        supabase
          .from("did_daily_session_plans")
          .select("id", { count: "exact", head: true })
          .in("status", ["generated", "in_progress"]),
        // Stale / archive-candidate: open tasks older than the stale
        // threshold BUT still within the visible-surface window (14 days).
        // Anything older than 14d is unreachable in any task surface and
        // would be a counter without dohledatelný obsah — explicitly
        // excluded so the counter and the briefing list are sladěné.
        supabase
          .from("did_therapist_tasks")
          .select("id", { count: "exact", head: true })
          .in("status", OPEN_TASK_STATUSES)
          .lt("created_at", staleCutoffISO)
          .gte("created_at", visibleFloorISO),
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
