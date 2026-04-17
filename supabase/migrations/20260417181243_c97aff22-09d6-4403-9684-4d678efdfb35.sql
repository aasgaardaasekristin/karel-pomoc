-- FÁZE 3: Canonical linkage columns

ALTER TABLE public.did_therapist_tasks
  ADD COLUMN IF NOT EXISTS plan_item_id uuid REFERENCES public.did_plan_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_did_therapist_tasks_plan_item_id
  ON public.did_therapist_tasks(plan_item_id) WHERE plan_item_id IS NOT NULL;

ALTER TABLE public.did_daily_session_plans
  ADD COLUMN IF NOT EXISTS crisis_event_id uuid REFERENCES public.crisis_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_did_daily_session_plans_crisis_event_id
  ON public.did_daily_session_plans(crisis_event_id) WHERE crisis_event_id IS NOT NULL;

ALTER TABLE public.did_meetings
  ADD COLUMN IF NOT EXISTS daily_plan_id uuid REFERENCES public.did_daily_session_plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_did_meetings_daily_plan_id
  ON public.did_meetings(daily_plan_id) WHERE daily_plan_id IS NOT NULL;

-- ── Safe high-confidence backfill ──

-- A) Daily plans → crisis_events (one open crisis matching part)
WITH cand AS (
  SELECT DISTINCT ON (dsp2.id) dsp2.id AS plan_id, ce.id AS event_id
  FROM public.did_daily_session_plans dsp2
  JOIN public.crisis_events ce
    ON ce.part_name = dsp2.selected_part
   AND ce.phase NOT IN ('closed', 'CLOSED')
   AND COALESCE(ce.opened_at, ce.created_at) <= (dsp2.plan_date + INTERVAL '1 day')
  WHERE dsp2.crisis_event_id IS NULL
  ORDER BY dsp2.id, ce.opened_at DESC NULLS LAST
)
UPDATE public.did_daily_session_plans dsp
SET crisis_event_id = cand.event_id
FROM cand
WHERE dsp.id = cand.plan_id;

-- B) Meetings → daily_plan_id (unique same-day, same-part candidate)
WITH cand AS (
  SELECT meeting_id, plan_id
  FROM (
    SELECT
      m2.id AS meeting_id,
      dsp.id AS plan_id,
      COUNT(*) OVER (PARTITION BY m2.id) AS cnt
    FROM public.did_meetings m2
    JOIN public.did_daily_session_plans dsp
      ON dsp.plan_date = (m2.created_at AT TIME ZONE 'Europe/Prague')::date
     AND dsp.selected_part IS NOT NULL
     AND m2.topic ILIKE '%' || dsp.selected_part || '%'
    WHERE m2.daily_plan_id IS NULL
  ) x
  WHERE cnt = 1
)
UPDATE public.did_meetings m
SET daily_plan_id = cand.plan_id
FROM cand
WHERE m.id = cand.meeting_id;

-- C) Manual tasks → plan_item_id (exact normalized text match, unique candidate)
WITH cand AS (
  SELECT task_id, item_id
  FROM (
    SELECT
      t2.id AS task_id,
      pi.id AS item_id,
      COUNT(*) OVER (PARTITION BY t2.id) AS cnt
    FROM public.did_therapist_tasks t2
    JOIN public.did_plan_items pi
      ON pi.status = 'active'
     AND length(coalesce(pi.action_required, '')) > 10
     AND lower(trim(t2.task)) = lower(trim(pi.action_required))
    WHERE t2.plan_item_id IS NULL
      AND t2.status IN ('pending', 'active', 'in_progress')
  ) x
  WHERE cnt = 1
)
UPDATE public.did_therapist_tasks t
SET plan_item_id = cand.item_id
FROM cand
WHERE t.id = cand.task_id;

COMMENT ON COLUMN public.did_therapist_tasks.plan_item_id IS
  'FÁZE 3: Link to canonical did_plan_items. When set, this manual/legacy task is a projection of a Karel-generated plan item and must be deduplicated in operational queue.';
COMMENT ON COLUMN public.did_daily_session_plans.crisis_event_id IS
  'FÁZE 3: Link to canonical crisis_events. When set, this daily session plan is operating under an active crisis context.';
COMMENT ON COLUMN public.did_meetings.daily_plan_id IS
  'FÁZE 3: Link to canonical did_daily_session_plans. Meeting is tied to a specific daily plan, not a parallel session reality.';