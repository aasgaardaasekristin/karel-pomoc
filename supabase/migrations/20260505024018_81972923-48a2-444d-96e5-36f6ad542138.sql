-- A. Mark legacy queued smoke event as superseded
UPDATE public.dynamic_pipeline_events
SET pipeline_state = 'superseded',
    consumed_by = COALESCE(consumed_by, '{}'::jsonb) || jsonb_build_object(
      'superseded_by', 'P28_CDI_2a_real_smoke',
      'superseded_at', now(),
      'reason', 'failed fake-task probe replaced by real task smoke'
    ),
    consumed_at = COALESCE(consumed_at, now())
WHERE id = '4aaca387-0bf0-4929-8b29-bc80d04724fd'
  AND pipeline_state = 'queued_for_consumption';

-- B. Allow new pipeline_state values (no enum used; column is text — defensive only)
-- C. Extend surface_resume_state columns (idempotent)
ALTER TABLE public.surface_resume_state
  ADD COLUMN IF NOT EXISTS approval_stage text,
  ADD COLUMN IF NOT EXISTS last_pending_decision text,
  ADD COLUMN IF NOT EXISTS question_id text,
  ADD COLUMN IF NOT EXISTS answered_by text,
  ADD COLUMN IF NOT EXISTS answer_summary text,
  ADD COLUMN IF NOT EXISTS card_update_id text,
  ADD COLUMN IF NOT EXISTS decision_status text,
  ADD COLUMN IF NOT EXISTS changed_fields jsonb,
  ADD COLUMN IF NOT EXISTS previous_status text,
  ADD COLUMN IF NOT EXISTS next_status text;