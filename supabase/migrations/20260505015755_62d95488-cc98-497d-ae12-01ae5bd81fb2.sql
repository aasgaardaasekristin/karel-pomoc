-- P28 C+D+I: Event-driven active sessions + dynamic pipeline events

-- 1) Active app activity sessions
CREATE TABLE IF NOT EXISTS public.active_app_activity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface text NOT NULL,
  surface_id text NOT NULL,
  surface_type text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  idle_after_minutes int NOT NULL DEFAULT 45,
  processing_interval_minutes int NOT NULL DEFAULT 15,
  status text NOT NULL DEFAULT 'active',
  last_processed_message_ord int,
  last_processed_at timestamptz,
  next_processing_at timestamptz DEFAULT (now() + interval '3 minutes'),
  current_phase text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, surface_type, surface_id)
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_next_proc
  ON public.active_app_activity_sessions (status, next_processing_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_active_sessions_user_activity
  ON public.active_app_activity_sessions (user_id, last_activity_at DESC);

ALTER TABLE public.active_app_activity_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own active sessions"
  ON public.active_app_activity_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users upsert own active sessions"
  ON public.active_app_activity_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users update own active sessions"
  ON public.active_app_activity_sessions FOR UPDATE
  USING (auth.uid() = user_id);

-- 2) Dynamic pipeline events (lightweight event log distinct from did_event_ingestion_log)
CREATE TABLE IF NOT EXISTS public.dynamic_pipeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface_type text NOT NULL,
  surface_id text NOT NULL,
  event_type text NOT NULL,
  source_table text,
  source_row_id text,
  safe_summary text,
  raw_allowed boolean NOT NULL DEFAULT false,
  pipeline_state text NOT NULL DEFAULT 'new_event',
  dedupe_key text,
  semantic_dedupe_key text,
  consumed_by jsonb,
  consumed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_pipeline_dedupe
  ON public.dynamic_pipeline_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dynamic_pipeline_state
  ON public.dynamic_pipeline_events (pipeline_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dynamic_pipeline_surface
  ON public.dynamic_pipeline_events (surface_type, surface_id, created_at DESC);

ALTER TABLE public.dynamic_pipeline_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own pipeline events"
  ON public.dynamic_pipeline_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own pipeline events"
  ON public.dynamic_pipeline_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 3) Resume state for interrupted sessions/deliberations/playrooms
CREATE TABLE IF NOT EXISTS public.surface_resume_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  surface_type text NOT NULL,
  surface_id text NOT NULL,
  current_block_index int,
  completed_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  skipped_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_open_question text,
  last_therapist_answer text,
  last_therapist_note text,
  reason_for_change text,
  next_resume_point text,
  what_changed_since_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, surface_type, surface_id)
);

ALTER TABLE public.surface_resume_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own resume state"
  ON public.surface_resume_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users upsert own resume state"
  ON public.surface_resume_state FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users update own resume state"
  ON public.surface_resume_state FOR UPDATE
  USING (auth.uid() = user_id);

-- 4) RPC: upsert active activity session (callable from client)
CREATE OR REPLACE FUNCTION public.upsert_active_activity_session(
  p_surface text,
  p_surface_id text,
  p_surface_type text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  INSERT INTO public.active_app_activity_sessions
    (user_id, surface, surface_id, surface_type, last_activity_at, next_processing_at, status, metadata)
  VALUES
    (v_uid, p_surface, p_surface_id, p_surface_type, now(), now() + interval '3 minutes', 'active', p_metadata)
  ON CONFLICT (user_id, surface_type, surface_id)
  DO UPDATE SET
    last_activity_at = now(),
    status = 'active',
    next_processing_at = LEAST(public.active_app_activity_sessions.next_processing_at, now() + interval '3 minutes'),
    metadata = public.active_app_activity_sessions.metadata || EXCLUDED.metadata
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_active_activity_session(text, text, text, jsonb) TO authenticated;