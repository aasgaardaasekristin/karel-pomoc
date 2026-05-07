CREATE TABLE IF NOT EXISTS public.p31_ai_polish_canary_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  briefing_id uuid NULL,
  briefing_date date NOT NULL,
  source_cycle_id uuid NULL,
  renderer_version text NULL,
  model text NULL,
  status text NOT NULL CHECK (status IN (
    'accepted_candidate',
    'rejected_all',
    'partial_candidates',
    'provider_not_configured',
    'provider_error',
    'validation_failed',
    'disabled'
  )),
  attempted boolean NOT NULL DEFAULT false,
  accepted_candidate_count int NOT NULL DEFAULT 0,
  rejected_candidate_count int NOT NULL DEFAULT 0,
  unsupported_claims_count int NOT NULL DEFAULT 0,
  robotic_phrase_count int NOT NULL DEFAULT 0,
  meaning_drift_count int NOT NULL DEFAULT 0,
  forbidden_phrase_hits jsonb NOT NULL DEFAULT '[]'::jsonb,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_p31_canary_user_date_created
  ON public.p31_ai_polish_canary_runs (user_id, briefing_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_p31_canary_briefing
  ON public.p31_ai_polish_canary_runs (briefing_id);

ALTER TABLE public.p31_ai_polish_canary_runs ENABLE ROW LEVEL SECURITY;

-- Authenticated users may read only their own rows
CREATE POLICY "p31_canary_select_own"
  ON public.p31_ai_polish_canary_runs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No client INSERT/UPDATE/DELETE policies => only service role can write