ALTER TABLE public.briefing_ask_resolutions
  ADD COLUMN IF NOT EXISTS decision_before_apply JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS decision_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS decision TEXT NULL,
  ADD COLUMN IF NOT EXISTS confidence TEXT NULL,
  ADD COLUMN IF NOT EXISTS requires_reapproval BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clinical_caution BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS evidence_level TEXT NOT NULL DEFAULT 'therapist_observation_D2',
  ADD COLUMN IF NOT EXISTS program_diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS session_params_diff JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pantry_entry_id UUID NULL,
  ADD COLUMN IF NOT EXISTS drive_package_id UUID NULL,
  ADD COLUMN IF NOT EXISTS drive_write_id UUID NULL,
  ADD COLUMN IF NOT EXISTS target_item_key TEXT NULL;

ALTER TABLE public.briefing_ask_resolutions
  DROP CONSTRAINT IF EXISTS briefing_ask_resolutions_resolution_mode_check;
ALTER TABLE public.briefing_ask_resolutions
  ADD CONSTRAINT briefing_ask_resolutions_resolution_mode_check
  CHECK (resolution_mode IN ('apply_to_program','apply_to_deliberation','store_observation','create_task','close_no_change','ask_for_clarification'));

ALTER TABLE public.briefing_ask_resolutions
  DROP CONSTRAINT IF EXISTS briefing_ask_resolutions_resolution_status_check;
ALTER TABLE public.briefing_ask_resolutions
  ADD CONSTRAINT briefing_ask_resolutions_resolution_status_check
  CHECK (resolution_status IN ('pending','applied_to_program','stored_as_observation','created_task','closed_no_change','needs_clarification','failed_retry'));

ALTER TABLE public.briefing_ask_resolutions
  DROP CONSTRAINT IF EXISTS briefing_ask_resolutions_decision_check;
ALTER TABLE public.briefing_ask_resolutions
  ADD CONSTRAINT briefing_ask_resolutions_decision_check
  CHECK (decision IS NULL OR decision IN ('apply_to_playroom_program','apply_to_session_program','apply_to_current_handling','store_as_observation','create_task','ask_for_clarification','close_no_change'));

ALTER TABLE public.briefing_ask_resolutions
  DROP CONSTRAINT IF EXISTS briefing_ask_resolutions_confidence_check;
ALTER TABLE public.briefing_ask_resolutions
  ADD CONSTRAINT briefing_ask_resolutions_confidence_check
  CHECK (confidence IS NULL OR confidence IN ('high','medium','low'));

ALTER TABLE public.briefing_ask_resolutions
  DROP CONSTRAINT IF EXISTS briefing_ask_resolutions_evidence_level_check;
ALTER TABLE public.briefing_ask_resolutions
  ADD CONSTRAINT briefing_ask_resolutions_evidence_level_check
  CHECK (evidence_level IN ('therapist_observation_D2','admin_note','direct_child_evidence','unknown'));

ALTER TABLE public.karel_pantry_b_entries
  DROP CONSTRAINT IF EXISTS karel_pantry_b_entries_source_kind_check;
ALTER TABLE public.karel_pantry_b_entries
  ADD CONSTRAINT karel_pantry_b_entries_source_kind_check
  CHECK (source_kind IN ('chat_postwriteback','team_deliberation','team_deliberation_answer','crisis_session','playroom','therapy_session','did_meeting','crisis_contact','manual','briefing_ask_resolution'));

CREATE INDEX IF NOT EXISTS idx_briefing_ask_resolutions_decision
ON public.briefing_ask_resolutions (decision, resolution_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_karel_pantry_b_briefing_ask_resolution
ON public.karel_pantry_b_entries (source_kind, source_ref, entry_kind)
WHERE source_kind = 'briefing_ask_resolution';