ALTER TABLE public.karel_action_jobs
ADD COLUMN IF NOT EXISTS plan_id uuid,
ADD COLUMN IF NOT EXISTS thread_id uuid,
ADD COLUMN IF NOT EXISTS part_name text,
ADD COLUMN IF NOT EXISTS review_id uuid,
ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error text,
ADD COLUMN IF NOT EXISTS finished_at timestamp with time zone;

ALTER TABLE public.karel_action_jobs
DROP CONSTRAINT IF EXISTS karel_action_jobs_status_check;

ALTER TABLE public.karel_action_jobs
ADD CONSTRAINT karel_action_jobs_status_check
CHECK (status IN ('pending','queued','running','completed','failed','failed_retry','failed_permanent','already_done'));

CREATE INDEX IF NOT EXISTS idx_karel_action_jobs_playroom_eval_pending
ON public.karel_action_jobs (job_type, status, created_at)
WHERE job_type = 'playroom_evaluation';

CREATE INDEX IF NOT EXISTS idx_karel_action_jobs_playroom_eval_review
ON public.karel_action_jobs (review_id)
WHERE job_type = 'playroom_evaluation';