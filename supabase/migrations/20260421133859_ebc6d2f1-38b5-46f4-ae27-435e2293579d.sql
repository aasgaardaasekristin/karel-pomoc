-- Spižírna B: Daily implication ledger (append-only)
-- Source: post-chat hooks, team deliberations, crisis sessions, meetings
-- Reader: karel-pantry-b-finalize (cron) → karel-did-daily-cycle morning flush
-- NOT a replacement for did_observations/did_implications. This sits ABOVE them
-- and represents "what follows from today for tomorrow" (proposals, follow-ups,
-- plan/hypothesis changes) before they get routed into the canonical pipeline.

CREATE TABLE IF NOT EXISTS public.karel_pantry_b_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- entry classification
  entry_kind text NOT NULL CHECK (entry_kind IN (
    'conclusion',         -- závěr z vlákna/sezení
    'state_change',       -- změna stavu části/terapeutky
    'proposal',           -- návrh zápisu/úpravy
    'risk',               -- nově detekované riziko
    'followup_need',      -- co je potřeba zítra dořešit
    'plan_change',        -- změna terapeutického plánu
    'hypothesis_change'   -- změna hypotézy
  )),
  -- where it came from
  source_kind text NOT NULL CHECK (source_kind IN (
    'chat_postwriteback',
    'team_deliberation',
    'crisis_session',
    'therapy_session',
    'did_meeting',
    'crisis_contact',
    'manual'
  )),
  source_ref text,                          -- thread_id / session_id / meeting_id
  -- payload
  summary text NOT NULL,                    -- one-liner pro morning brief
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- routing intent (where this should land at flush)
  intended_destinations text[] NOT NULL DEFAULT '{}',
  -- intended targets like:
  --   'did_implications', 'did_therapist_tasks', 'did_pending_questions',
  --   'crisis_event_update', 'briefing_input'
  related_part_name text,
  related_therapist text CHECK (related_therapist IN ('hanka', 'kata') OR related_therapist IS NULL),
  related_crisis_event_id uuid,
  -- lifecycle
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,                 -- set by morning flush
  processed_by text,                        -- function name that flushed it
  flush_result jsonb,                       -- audit of where it landed
  -- 14-day retention guard
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')
);

CREATE INDEX IF NOT EXISTS idx_pantry_b_user_unprocessed
  ON public.karel_pantry_b_entries (user_id, created_at DESC)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pantry_b_user_part
  ON public.karel_pantry_b_entries (user_id, related_part_name)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pantry_b_expires
  ON public.karel_pantry_b_entries (expires_at);

ALTER TABLE public.karel_pantry_b_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pantry_b_user_select"
  ON public.karel_pantry_b_entries
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "pantry_b_user_insert"
  ON public.karel_pantry_b_entries
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "pantry_b_user_update"
  ON public.karel_pantry_b_entries
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.karel_pantry_b_entries IS
  'Spižírna B — denní implikační deník (append-only). Plněn během dne (chat post-hooks, porady, sezení), flushován ráno do canonical pipeline (did_implications / did_therapist_tasks / did_pending_questions). NENÍ náhradou did_observations; sedí NAD nimi a reprezentuje "co z dneška plyne pro zítřek".';