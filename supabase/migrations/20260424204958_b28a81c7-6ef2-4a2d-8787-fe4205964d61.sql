CREATE TABLE IF NOT EXISTS public.did_live_session_progress (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.did_daily_session_plans(id) ON DELETE CASCADE,
  part_name text NOT NULL DEFAULT '',
  therapist text NOT NULL DEFAULT '',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  turns_by_block jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifacts_by_block jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_blocks integer NOT NULL DEFAULT 0,
  total_blocks integer NOT NULL DEFAULT 0,
  last_activity_at timestamp with time zone NOT NULL DEFAULT now(),
  finalized_at timestamp with time zone,
  finalized_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (plan_id)
);

ALTER TABLE public.did_live_session_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own live session progress"
ON public.did_live_session_progress
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own live session progress"
ON public.did_live_session_progress
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own live session progress"
ON public.did_live_session_progress
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own live session progress"
ON public.did_live_session_progress
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_did_live_session_progress_user_plan
ON public.did_live_session_progress(user_id, plan_id);

CREATE INDEX IF NOT EXISTS idx_did_live_session_progress_activity
ON public.did_live_session_progress(last_activity_at DESC);

CREATE OR REPLACE FUNCTION public.did_live_session_progress_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.last_activity_at = COALESCE(NEW.last_activity_at, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_did_live_session_progress_updated_at ON public.did_live_session_progress;
CREATE TRIGGER trg_did_live_session_progress_updated_at
BEFORE UPDATE ON public.did_live_session_progress
FOR EACH ROW
EXECUTE FUNCTION public.did_live_session_progress_set_updated_at();