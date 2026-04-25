CREATE TABLE public.karel_action_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  job_type text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL,
  target_type text,
  target_id text,
  source_function text,
  result_summary text,
  result_payload jsonb DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT karel_action_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'already_done'))
);

ALTER TABLE public.karel_action_jobs ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX idx_karel_action_jobs_dedupe_key
  ON public.karel_action_jobs (dedupe_key);

CREATE INDEX idx_karel_action_jobs_user_created
  ON public.karel_action_jobs (user_id, created_at DESC);

CREATE INDEX idx_karel_action_jobs_type_target
  ON public.karel_action_jobs (job_type, target_id);

CREATE OR REPLACE FUNCTION public.karel_action_jobs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_karel_action_jobs_updated_at
BEFORE UPDATE ON public.karel_action_jobs
FOR EACH ROW
EXECUTE FUNCTION public.karel_action_jobs_set_updated_at();

CREATE POLICY "Users can view own action jobs"
ON public.karel_action_jobs
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);