-- P29B.2-CF: payload table for detached daily-cycle phase jobs.
-- Avoids storing >100KB tail snapshots in did_update_cycles.context_data.

CREATE TABLE IF NOT EXISTS public.did_daily_cycle_phase_payloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES public.did_update_cycles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  job_kind text NOT NULL,
  payload_kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_did_daily_cycle_phase_payloads_cycle_kind
  ON public.did_daily_cycle_phase_payloads(cycle_id, job_kind);

CREATE INDEX IF NOT EXISTS idx_did_daily_cycle_phase_payloads_user_created
  ON public.did_daily_cycle_phase_payloads(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_did_daily_cycle_phase_payloads_cycle_kind_payload_kind
  ON public.did_daily_cycle_phase_payloads(cycle_id, job_kind, payload_kind);

ALTER TABLE public.did_daily_cycle_phase_payloads ENABLE ROW LEVEL SECURITY;

-- Service-role only (no authenticated user policies); orchestrator + worker access via service key.
DROP POLICY IF EXISTS "phase_payloads_service_only_select" ON public.did_daily_cycle_phase_payloads;
CREATE POLICY "phase_payloads_service_only_select"
  ON public.did_daily_cycle_phase_payloads
  FOR SELECT
  USING (false);

DROP POLICY IF EXISTS "phase_payloads_service_only_modify" ON public.did_daily_cycle_phase_payloads;
CREATE POLICY "phase_payloads_service_only_modify"
  ON public.did_daily_cycle_phase_payloads
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.tg_did_phase_payloads_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_did_phase_payloads_updated_at ON public.did_daily_cycle_phase_payloads;
CREATE TRIGGER trg_did_phase_payloads_updated_at
  BEFORE UPDATE ON public.did_daily_cycle_phase_payloads
  FOR EACH ROW EXECUTE FUNCTION public.tg_did_phase_payloads_updated_at();