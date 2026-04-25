ALTER TABLE public.did_pending_questions
ADD COLUMN IF NOT EXISTS follow_up_result jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.did_pending_questions.follow_up_result
IS 'Structured result of Karel-direct follow-up processing; planning input only, not clinical truth.';