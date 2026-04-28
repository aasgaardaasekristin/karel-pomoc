ALTER TABLE public.did_live_session_progress
  ADD COLUMN IF NOT EXISTS current_block_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS active_live_replan_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS live_replan_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reality_verification JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.did_live_session_progress.current_block_status IS
  'Runtime status aktuálního bloku při hard reality override, např. paused_by_reality_override nebo superseded_by_live_replan.';

COMMENT ON COLUMN public.did_live_session_progress.active_live_replan_id IS
  'ID aktivního LIVE_REPLAN_PATCH, který autoritativně mění běh aktuálního sezení.';

COMMENT ON COLUMN public.did_live_session_progress.live_replan_patch IS
  'Strukturovaný LIVE_REPLAN_PATCH vygenerovaný při faktické korekci reality v živém sezení.';

COMMENT ON COLUMN public.did_live_session_progress.reality_verification IS
  'Krátký audit ověření reality: URL metadata, verification_status a limity pro child-facing sdělení.';

ALTER TABLE public.karel_pantry_b_entries
  DROP CONSTRAINT IF EXISTS karel_pantry_b_entries_source_kind_check;

ALTER TABLE public.karel_pantry_b_entries
  ADD CONSTRAINT karel_pantry_b_entries_source_kind_check
  CHECK (source_kind IN (
    'chat_postwriteback',
    'team_deliberation',
    'team_deliberation_answer',
    'crisis_session',
    'playroom',
    'therapy_session',
    'did_meeting',
    'crisis_contact',
    'manual',
    'briefing_ask_resolution',
    'live_session_reality_override'
  ));

CREATE INDEX IF NOT EXISTS idx_did_live_session_progress_live_replan
ON public.did_live_session_progress(user_id, active_live_replan_id)
WHERE active_live_replan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pantry_b_live_session_reality_override
ON public.karel_pantry_b_entries(source_kind, source_ref, entry_kind)
WHERE source_kind = 'live_session_reality_override';