CREATE TABLE IF NOT EXISTS public.did_session_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  part_name text,
  session_date date NOT NULL,
  status text NOT NULL DEFAULT 'evidence_limited',
  review_kind text NOT NULL DEFAULT 'scheduled_session',
  analysis_version text NOT NULL DEFAULT 'did-session-review-v1',
  source_data_summary text,
  evidence_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_available boolean NOT NULL DEFAULT false,
  live_progress_available boolean NOT NULL DEFAULT false,
  clinical_summary text,
  therapeutic_implications text,
  team_implications text,
  next_session_recommendation text,
  evidence_limitations text,
  projection_status text NOT NULL DEFAULT 'not_queued',
  retry_count integer NOT NULL DEFAULT 0,
  error_message text,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT did_session_reviews_status_check CHECK (status IN ('analyzed','partially_analyzed','evidence_limited','failed_analysis','cancelled')),
  CONSTRAINT did_session_reviews_projection_status_check CHECK (projection_status IN ('not_queued','queued','projected','failed','skipped')),
  CONSTRAINT did_session_reviews_evidence_items_array CHECK (jsonb_typeof(evidence_items) = 'array'),
  CONSTRAINT did_session_reviews_completed_items_array CHECK (jsonb_typeof(completed_checklist_items) = 'array'),
  CONSTRAINT did_session_reviews_missing_items_array CHECK (jsonb_typeof(missing_checklist_items) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS did_session_reviews_one_current_per_plan
  ON public.did_session_reviews(plan_id)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_did_session_reviews_user_date
  ON public.did_session_reviews(user_id, session_date DESC);

CREATE INDEX IF NOT EXISTS idx_did_session_reviews_plan
  ON public.did_session_reviews(plan_id);

ALTER TABLE public.did_session_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own DID session reviews" ON public.did_session_reviews;
CREATE POLICY "Users can view their own DID session reviews"
ON public.did_session_reviews
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own DID session reviews" ON public.did_session_reviews;
CREATE POLICY "Users can create their own DID session reviews"
ON public.did_session_reviews
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own DID session reviews" ON public.did_session_reviews;
CREATE POLICY "Users can update their own DID session reviews"
ON public.did_session_reviews
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.did_session_reviews_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS did_session_reviews_set_updated_at ON public.did_session_reviews;
CREATE TRIGGER did_session_reviews_set_updated_at
BEFORE UPDATE ON public.did_session_reviews
FOR EACH ROW
EXECUTE FUNCTION public.did_session_reviews_set_updated_at();

ALTER TABLE public.did_daily_session_plans
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'planned',
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_source text,
  ADD COLUMN IF NOT EXISTS finalization_reason text,
  ADD COLUMN IF NOT EXISTS analysis_error text;

ALTER TABLE public.did_daily_session_plans
  DROP CONSTRAINT IF EXISTS did_daily_session_plans_lifecycle_status_check;

ALTER TABLE public.did_daily_session_plans
  ADD CONSTRAINT did_daily_session_plans_lifecycle_status_check
  CHECK (lifecycle_status IN ('planned','in_progress','awaiting_analysis','analyzed','partially_analyzed','evidence_limited','failed_analysis','cancelled'));

CREATE INDEX IF NOT EXISTS idx_did_daily_session_plans_lifecycle_date
  ON public.did_daily_session_plans(plan_date, lifecycle_status);
