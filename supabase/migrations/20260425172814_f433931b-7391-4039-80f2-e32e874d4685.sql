ALTER TABLE public.did_live_session_progress
  ADD COLUMN IF NOT EXISTS post_session_result jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.did_live_session_progress.post_session_result IS
  'Structured MVP post-session result payload, including evidenceValidity, contactOccurred, outcome, and checklist signals.';

ALTER TABLE public.did_session_reviews
  ADD COLUMN IF NOT EXISTS analysis_json jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.did_session_reviews.analysis_json IS
  'Structured clinical analysis supplement for confirmed_facts, working_deductions, unknowns, and writeback candidates; does not replace legacy summary fields.';