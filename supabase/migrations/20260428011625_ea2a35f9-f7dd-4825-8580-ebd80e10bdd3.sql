ALTER TABLE public.karel_pantry_b_entries
  DROP CONSTRAINT IF EXISTS karel_pantry_b_entries_source_kind_check;

ALTER TABLE public.karel_pantry_b_entries
  ADD CONSTRAINT karel_pantry_b_entries_source_kind_check
  CHECK (source_kind IN ('chat_postwriteback','team_deliberation','team_deliberation_answer','crisis_session','therapy_session','did_meeting','crisis_contact','manual','playroom'));

CREATE TABLE IF NOT EXISTS public.did_cycle_run_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_cycle_date date NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Prague',
  cycle_kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT did_cycle_run_log_status_check CHECK (status IN ('running','completed','skipped','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS did_cycle_run_log_one_completed_per_day_kind
  ON public.did_cycle_run_log(local_cycle_date, cycle_kind)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_did_cycle_run_log_kind_date
  ON public.did_cycle_run_log(cycle_kind, local_cycle_date DESC);

ALTER TABLE public.did_cycle_run_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view DID cycle run log" ON public.did_cycle_run_log;
CREATE POLICY "Users can view DID cycle run log"
ON public.did_cycle_run_log
FOR SELECT
USING (true);

CREATE OR REPLACE FUNCTION public.did_cycle_run_log_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS did_cycle_run_log_set_updated_at ON public.did_cycle_run_log;
CREATE TRIGGER did_cycle_run_log_set_updated_at
BEFORE UPDATE ON public.did_cycle_run_log
FOR EACH ROW
EXECUTE FUNCTION public.did_cycle_run_log_set_updated_at();