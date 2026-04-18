-- BUGFIX: Replace risky fuzzy backfill with STRICT-ONLY matching + audit log.
-- Earlier migration 20260418130935 paired threads against EITHER 60-char OR
-- length-of-label slices, and for sessions it picked "most recent" plan for a
-- part — both are silent and risky. We now:
--   1) Create a verification log table.
--   2) Run STRICT matching (exact 60-char prefix) and only stamp threads
--      where exactly ONE candidate exists. Ambiguous and unmatched are
--      logged for manual review.
--
-- IMPORTANT: previous migration's UPDATE only ran on rows where workspace_id
-- IS NULL — so this strict pass never overwrites a row already stamped.

CREATE TABLE IF NOT EXISTS public.did_threads_workspace_backfill_log (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null,
  workspace_type text not null,
  label_slice   text not null,
  match_status  text not null,
  candidate_ids uuid[] default '{}',
  created_at    timestamptz not null default now()
);

ALTER TABLE public.did_threads_workspace_backfill_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access on backfill log" ON public.did_threads_workspace_backfill_log;
CREATE POLICY "service role full access on backfill log"
  ON public.did_threads_workspace_backfill_log
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 1) TASK threads — strict 60-char prefix match, only on UNIQUE candidate ──
WITH labeled AS (
  SELECT t.id AS thread_id,
         lower(btrim(substring(t.thread_label FROM 7))) AS label_slice
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode IN ('mamka', 'kata')
    AND t.thread_label LIKE 'Úkol: %'
),
candidates AS (
  SELECT l.thread_id,
         l.label_slice,
         array_agg(tt.id ORDER BY tt.created_at DESC) AS task_ids
  FROM labeled l
  LEFT JOIN public.did_therapist_tasks tt
    ON lower(btrim(substring(tt.task FROM 1 FOR 60))) = l.label_slice
  GROUP BY l.thread_id, l.label_slice
),
classified AS (
  SELECT thread_id, label_slice, task_ids,
    CASE
      WHEN array_length(task_ids, 1) = 1 THEN 'matched'
      WHEN array_length(task_ids, 1) IS NULL THEN 'unmatched'
      ELSE 'ambiguous'
    END AS status
  FROM candidates
),
log_insert AS (
  INSERT INTO public.did_threads_workspace_backfill_log (thread_id, workspace_type, label_slice, match_status, candidate_ids)
  SELECT thread_id, 'task', label_slice, status, COALESCE(task_ids, '{}')
  FROM classified
  RETURNING 1
)
UPDATE public.did_threads dt
SET workspace_type = 'task',
    workspace_id   = c.task_ids[1]
FROM classified c
WHERE c.status = 'matched'
  AND dt.id = c.thread_id;

-- ── 2) QUESTION threads — strict 60-char prefix match, only on UNIQUE ──
WITH labeled AS (
  SELECT t.id AS thread_id,
         lower(btrim(substring(t.thread_label FROM 9))) AS label_slice
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode IN ('mamka', 'kata')
    AND t.thread_label LIKE 'Otázka: %'
),
candidates AS (
  SELECT l.thread_id,
         l.label_slice,
         array_agg(pq.id ORDER BY pq.created_at DESC) AS question_ids
  FROM labeled l
  LEFT JOIN public.did_pending_questions pq
    ON lower(btrim(substring(pq.question FROM 1 FOR 60))) = l.label_slice
  GROUP BY l.thread_id, l.label_slice
),
classified AS (
  SELECT thread_id, label_slice, question_ids,
    CASE
      WHEN array_length(question_ids, 1) = 1 THEN 'matched'
      WHEN array_length(question_ids, 1) IS NULL THEN 'unmatched'
      ELSE 'ambiguous'
    END AS status
  FROM candidates
),
log_insert AS (
  INSERT INTO public.did_threads_workspace_backfill_log (thread_id, workspace_type, label_slice, match_status, candidate_ids)
  SELECT thread_id, 'question', label_slice, status, COALESCE(question_ids, '{}')
  FROM classified
  RETURNING 1
)
UPDATE public.did_threads dt
SET workspace_type = 'question',
    workspace_id   = c.question_ids[1]
FROM classified c
WHERE c.status = 'matched'
  AND dt.id = c.thread_id;

-- ── 3) SESSION threads — DO NOT auto-bind. Log only. ──
-- Previous migration silently picked "most recent plan for part" — that is
-- exactly the kind of fuzzy guess the user rejected. We log candidates so
-- a human can decide which historical session_plan to bind, but stamp
-- nothing automatically.
WITH labeled AS (
  SELECT t.id AS thread_id,
         lower(btrim(substring(t.thread_label FROM 9))) AS part_slice
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode = 'mamka'
    AND t.thread_label LIKE 'Sezení: %'
),
candidates AS (
  SELECT l.thread_id,
         l.part_slice,
         array_agg(sp.id ORDER BY sp.created_at DESC) AS session_ids
  FROM labeled l
  LEFT JOIN public.did_daily_session_plans sp
    ON lower(sp.selected_part) = l.part_slice
  GROUP BY l.thread_id, l.part_slice
)
INSERT INTO public.did_threads_workspace_backfill_log (thread_id, workspace_type, label_slice, match_status, candidate_ids)
SELECT thread_id,
       'session',
       part_slice,
       'review_required',
       COALESCE(session_ids, '{}')
FROM candidates;