/**
 * useDailyLifecycle.ts — Slice 3B
 *
 * Načte zdroje pro derived lifecycle a vrátí předpočítané UI buckety
 * pomocí pure resolveru (`src/lib/dailyLifecycleResolver.ts`).
 *
 * Žádný side effect kromě fetch + state. Žádné writes. Slouží jen
 * jako read-only čočka pro decision deck a operativu dne.
 *
 * Reaguje na:
 *   - `refreshTrigger` (z parentu)
 *   - PENDING_QUESTIONS_CHANGED_EVENT (živá synchronizace s Q&A panelem)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import {
  resolveDailyLifecycle,
  RawTaskRow,
  RawPendingQuestionRow,
  RawBriefingWaitingItem,
  RawCrisisEventRow,
  RawSessionProposal,
} from "@/lib/dailyLifecycleResolver";
import {
  DailyLifecycleBuckets,
  EMPTY_BUCKETS,
} from "@/types/dailyLifecycle";
import { PENDING_QUESTIONS_CHANGED_EVENT } from "@/lib/pendingQuestionStatuses";

interface UseDailyLifecycleResult {
  buckets: DailyLifecycleBuckets;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const TASK_STATUSES_OF_INTEREST = ["pending", "archived", "expired"];
const QUESTION_STATUSES_OF_INTEREST = ["open", "answered", "archived", "expired"];

interface BriefingPayloadShape {
  waiting_for?: string[];
  proposed_session?: {
    id?: string | null;
    part_name: string;
    why_today: string;
  } | null;
}

export function useDailyLifecycle(refreshTrigger?: number): UseDailyLifecycleResult {
  const [buckets, setBuckets] = useState<DailyLifecycleBuckets>(EMPTY_BUCKETS);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [internalRefresh, setInternalRefresh] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = pragueTodayISO();

      // Paralelně načteme všechny zdroje. Selhání jednoho nesmí shodit
      // celý decision deck — proto Promise.allSettled.
      const [tasksRes, questionsRes, briefingRes, crisisRes] = await Promise.allSettled([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, status, assigned_to, status_hanka, status_kata, escalation_level, due_date, created_at, completed_at, task_tier")
          .in("status", TASK_STATUSES_OF_INTEREST)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("did_pending_questions")
          .select("id, question, status, blocking, directed_to, created_at, expires_at, answer, answered_at, crisis_event_id, subject_type")
          .in("status", QUESTION_STATUSES_OF_INTEREST)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("did_daily_briefings")
          .select("briefing_date, payload")
          .eq("briefing_date", today)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("crisis_events")
          .select("id, part_name, closed_at, last_morning_review_at, last_evening_decision_at, awaiting_response_from, primary_therapist, severity")
          .is("closed_at", null)
          .limit(50),
      ]);

      const tasks: RawTaskRow[] =
        tasksRes.status === "fulfilled" && !tasksRes.value.error
          ? ((tasksRes.value.data as unknown as RawTaskRow[]) || [])
          : [];

      const questions: RawPendingQuestionRow[] =
        questionsRes.status === "fulfilled" && !questionsRes.value.error
          ? ((questionsRes.value.data as unknown as RawPendingQuestionRow[]) || [])
          : [];

      const briefingRow =
        briefingRes.status === "fulfilled" && !briefingRes.value.error
          ? briefingRes.value.data
          : null;

      const briefingPayload: BriefingPayloadShape | null =
        (briefingRow?.payload as BriefingPayloadShape | null) ?? null;

      const briefingWaitingFor: RawBriefingWaitingItem[] = (briefingPayload?.waiting_for ?? [])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => ({ text: t, briefing_date: briefingRow?.briefing_date || today }));

      const crisisEvents: RawCrisisEventRow[] =
        crisisRes.status === "fulfilled" && !crisisRes.value.error
          ? ((crisisRes.value.data as unknown as RawCrisisEventRow[]) || [])
          : [];

      const sessionProposals: RawSessionProposal[] = [];
      if (briefingPayload?.proposed_session?.part_name) {
        sessionProposals.push({
          id: briefingPayload.proposed_session.id ?? null,
          part_name: briefingPayload.proposed_session.part_name,
          why_today: briefingPayload.proposed_session.why_today,
          briefing_date: briefingRow?.briefing_date || today,
          isScheduled: false,
        });
      }

      const next = resolveDailyLifecycle({
        tasks,
        questions,
        briefingWaitingFor,
        crisisEvents,
        sessionProposals,
      });
      setBuckets(next);
    } catch (e) {
      console.error("[useDailyLifecycle] load failed", e);
      setError(e instanceof Error ? e.message : "Načtení selhalo");
      setBuckets(EMPTY_BUCKETS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshTrigger, internalRefresh]);

  // Jakmile někdo odpoví na pending question, dashboard musí přepočítat
  // decision deck — sdílíme stejný event jako PendingQuestionsPanel.
  useEffect(() => {
    const handler = () => setInternalRefresh((n) => n + 1);
    if (typeof window !== "undefined") {
      window.addEventListener(PENDING_QUESTIONS_CHANGED_EVENT, handler);
      return () => window.removeEventListener(PENDING_QUESTIONS_CHANGED_EVENT, handler);
    }
  }, []);

  return useMemo(
    () => ({ buckets, loading, error, reload }),
    [buckets, loading, error, reload],
  );
}
