
CREATE TABLE IF NOT EXISTS public.external_reality_daily_orchestrator_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  run_date date NOT NULL,
  source_cycle_id uuid,
  truth_gate_ok boolean NOT NULL DEFAULT false,
  truth_gate_status text,
  provider_status text,
  internet_watch_run_id uuid,
  events_created integer NOT NULL DEFAULT 0,
  events_deduped integer NOT NULL DEFAULT 0,
  active_part_briefs_upserted integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  error_message text,
  source text,
  forced boolean NOT NULL DEFAULT false,
  idempotent_skip boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ext_reality_orchestrator_per_day
  ON public.external_reality_daily_orchestrator_runs (user_id, run_date, COALESCE(source_cycle_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS ix_ext_reality_orchestrator_run_date
  ON public.external_reality_daily_orchestrator_runs (run_date DESC);

ALTER TABLE public.external_reality_daily_orchestrator_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ext_reality_orch_runs_select_own" ON public.external_reality_daily_orchestrator_runs;
CREATE POLICY "ext_reality_orch_runs_select_own"
  ON public.external_reality_daily_orchestrator_runs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
