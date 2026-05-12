-- P33.11: Hard server-side state for intelligent playroom program execution.
-- Isolated table to avoid coupling with did_threads / did_live_session_progress lifecycles.

CREATE TABLE IF NOT EXISTS public.did_playroom_runtime_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  playroom_plan_id uuid,
  owner_user_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'checkin',
  current_block_index integer NOT NULL DEFAULT 0,
  consecutive_stabilize_count integer NOT NULL DEFAULT 0,
  program_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT did_playroom_runtime_state_thread_unique UNIQUE (thread_id)
);

-- Validation: phase must be one of the four contracted values.
CREATE OR REPLACE FUNCTION public.did_playroom_runtime_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.phase NOT IN ('checkin','program','stabilization','soft_close') THEN
    RAISE EXCEPTION 'invalid playroom phase: %', NEW.phase;
  END IF;
  IF NEW.current_block_index < 0 THEN
    RAISE EXCEPTION 'current_block_index must be >= 0';
  END IF;
  IF NEW.consecutive_stabilize_count < 0 THEN
    RAISE EXCEPTION 'consecutive_stabilize_count must be >= 0';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS did_playroom_runtime_state_validate ON public.did_playroom_runtime_state;
CREATE TRIGGER did_playroom_runtime_state_validate
  BEFORE INSERT OR UPDATE ON public.did_playroom_runtime_state
  FOR EACH ROW EXECUTE FUNCTION public.did_playroom_runtime_validate();

CREATE INDEX IF NOT EXISTS idx_did_playroom_runtime_owner ON public.did_playroom_runtime_state(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_did_playroom_runtime_thread ON public.did_playroom_runtime_state(thread_id);

ALTER TABLE public.did_playroom_runtime_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can read own playroom runtime"
  ON public.did_playroom_runtime_state
  FOR SELECT
  USING (auth.uid() = owner_user_id);

CREATE POLICY "owner can insert own playroom runtime"
  ON public.did_playroom_runtime_state
  FOR INSERT
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "owner can update own playroom runtime"
  ON public.did_playroom_runtime_state
  FOR UPDATE
  USING (auth.uid() = owner_user_id);

CREATE POLICY "owner can delete own playroom runtime"
  ON public.did_playroom_runtime_state
  FOR DELETE
  USING (auth.uid() = owner_user_id);
