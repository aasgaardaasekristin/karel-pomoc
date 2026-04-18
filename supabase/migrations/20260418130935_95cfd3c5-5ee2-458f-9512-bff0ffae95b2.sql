-- BUGFIX: Backfill workspace identity for legacy "Karel" task threads
-- Match did_threads where:
--   sub_mode IN ('mamka','kata') AND part_name='Karel' AND thread_label LIKE 'Úkol: %' (or 'Otázka: %')
-- to the most recent did_therapist_tasks / did_pending_questions row whose first 60 chars
-- of `task` / `question` match the slice in thread_label, and stamp workspace_type + workspace_id.
--
-- Without this backfill, reopening an existing assigned task would fail the
-- canonical lookup and spawn a brand new "Karel" thread, splintering history.

-- 1) TASK threads (label format: "Úkol: <first 60 chars of task>")
WITH labeled AS (
  SELECT
    t.id AS thread_id,
    btrim(substring(t.thread_label FROM 7)) AS label_slice  -- strip "Úkol: " prefix (7 chars)
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode IN ('mamka', 'kata')
    AND t.thread_label LIKE 'Úkol: %'
),
matched AS (
  SELECT DISTINCT ON (l.thread_id)
    l.thread_id,
    tt.id AS task_id
  FROM labeled l
  JOIN public.did_therapist_tasks tt
    ON lower(btrim(substring(tt.task FROM 1 FOR 60))) = lower(l.label_slice)
       OR lower(btrim(substring(tt.task FROM 1 FOR length(l.label_slice)))) = lower(l.label_slice)
  ORDER BY l.thread_id, tt.created_at DESC
)
UPDATE public.did_threads dt
SET workspace_type = 'task',
    workspace_id   = m.task_id
FROM matched m
WHERE dt.id = m.thread_id;

-- 2) QUESTION threads (label format: "Otázka: <first 60 chars>")
WITH labeled AS (
  SELECT
    t.id AS thread_id,
    btrim(substring(t.thread_label FROM 9)) AS label_slice  -- strip "Otázka: " prefix (9 chars)
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode IN ('mamka', 'kata')
    AND t.thread_label LIKE 'Otázka: %'
),
matched AS (
  SELECT DISTINCT ON (l.thread_id)
    l.thread_id,
    pq.id AS question_id
  FROM labeled l
  JOIN public.did_pending_questions pq
    ON lower(btrim(substring(pq.question FROM 1 FOR 60))) = lower(l.label_slice)
       OR lower(btrim(substring(pq.question FROM 1 FOR length(l.label_slice)))) = lower(l.label_slice)
  ORDER BY l.thread_id, pq.created_at DESC
)
UPDATE public.did_threads dt
SET workspace_type = 'question',
    workspace_id   = m.question_id
FROM matched m
WHERE dt.id = m.thread_id;

-- 3) SESSION threads (label format: "Sezení: <part_name>")
-- Match against today's (or most recent) did_daily_session_plan for that part.
WITH labeled AS (
  SELECT
    t.id AS thread_id,
    btrim(substring(t.thread_label FROM 9)) AS part_slice  -- strip "Sezení: " prefix (9 chars)
  FROM public.did_threads t
  WHERE t.workspace_type IS NULL
    AND t.workspace_id IS NULL
    AND t.part_name = 'Karel'
    AND t.sub_mode = 'mamka'
    AND t.thread_label LIKE 'Sezení: %'
),
matched AS (
  SELECT DISTINCT ON (l.thread_id)
    l.thread_id,
    sp.id AS session_id
  FROM labeled l
  JOIN public.did_daily_session_plans sp
    ON lower(sp.selected_part) = lower(l.part_slice)
  ORDER BY l.thread_id, sp.created_at DESC
)
UPDATE public.did_threads dt
SET workspace_type = 'session',
    workspace_id   = m.session_id
FROM matched m
WHERE dt.id = m.thread_id;