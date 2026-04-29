CREATE TABLE IF NOT EXISTS public.did_daily_briefing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  briefing_date date NOT NULL,
  generation_method text NOT NULL DEFAULT 'manual',
  trigger_source text NOT NULL DEFAULT 'ui',
  auth_mode text NOT NULL DEFAULT 'user',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'started',
  error_code text,
  error_message text,
  cycle_status text,
  cycle_id uuid,
  created_briefing_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_did_daily_briefing_attempts_user_date
ON public.did_daily_briefing_attempts (user_id, briefing_date DESC, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_did_daily_briefing_attempts_created_at
ON public.did_daily_briefing_attempts (created_at DESC);

ALTER TABLE public.did_daily_briefing_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own briefing attempts" ON public.did_daily_briefing_attempts;
CREATE POLICY "Users can read own briefing attempts"
ON public.did_daily_briefing_attempts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_did_daily_briefing_attempts_updated_at ON public.did_daily_briefing_attempts;
CREATE TRIGGER update_did_daily_briefing_attempts_updated_at
BEFORE UPDATE ON public.did_daily_briefing_attempts
FOR EACH ROW
EXECUTE FUNCTION public.tdelib_set_updated_at();