ALTER TABLE public.karel_pantry_b_entries
  DROP CONSTRAINT IF EXISTS karel_pantry_b_entries_entry_kind_check;

ALTER TABLE public.karel_pantry_b_entries
  ADD CONSTRAINT karel_pantry_b_entries_entry_kind_check
  CHECK (entry_kind IN (
    'conclusion',
    'observation',
    'state_change',
    'proposal',
    'risk',
    'followup_need',
    'plan_change',
    'hypothesis_change',
    'task',
    'admin_note'
  ));

ALTER TABLE public.karel_pantry_b_entries
  DROP CONSTRAINT IF EXISTS karel_pantry_b_entries_source_kind_check;

ALTER TABLE public.karel_pantry_b_entries
  ADD CONSTRAINT karel_pantry_b_entries_source_kind_check
  CHECK (source_kind IN (
    'chat_postwriteback',
    'team_deliberation',
    'team_deliberation_answer',
    'briefing_ask_resolution',
    'crisis_session',
    'playroom',
    'therapy_session',
    'live_session_reality_override',
    'did_meeting',
    'crisis_contact',
    'manual',
    'therapist_task_note',
    'therapist_note',
    'hana_personal_ingestion',
    'did_thread_ingestion',
    'live_session_progress',
    'playroom_progress',
    'deliberation_event',
    'crisis_safety_event'
  ));