
-- =========================================================================
-- P29B: did_daily_cycle_phase_jobs
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.did_daily_cycle_phase_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid REFERENCES public.did_update_cycles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  phase_name text NOT NULL,
  job_kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority text NOT NULL DEFAULT 'normal',
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  idempotency_key text NOT NULL UNIQUE,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  next_retry_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT did_daily_cycle_phase_jobs_status_chk CHECK (
    status IN ('queued','running','completed','failed_retry','failed_permanent','controlled_skipped')
  )
);

CREATE INDEX IF NOT EXISTS did_daily_cycle_phase_jobs_cycle_phase_idx
  ON public.did_daily_cycle_phase_jobs (cycle_id, phase_name);
CREATE INDEX IF NOT EXISTS did_daily_cycle_phase_jobs_status_retry_idx
  ON public.did_daily_cycle_phase_jobs (status, next_retry_at);
CREATE INDEX IF NOT EXISTS did_daily_cycle_phase_jobs_user_created_idx
  ON public.did_daily_cycle_phase_jobs (user_id, created_at);

ALTER TABLE public.did_daily_cycle_phase_jobs ENABLE ROW LEVEL SECURITY;

-- service-role only; no end-user policies (internal background queue).
DROP POLICY IF EXISTS "phase_jobs_no_anon" ON public.did_daily_cycle_phase_jobs;
CREATE POLICY "phase_jobs_no_anon"
  ON public.did_daily_cycle_phase_jobs
  FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.did_daily_cycle_phase_jobs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_did_daily_cycle_phase_jobs_updated_at ON public.did_daily_cycle_phase_jobs;
CREATE TRIGGER trg_did_daily_cycle_phase_jobs_updated_at
  BEFORE UPDATE ON public.did_daily_cycle_phase_jobs
  FOR EACH ROW EXECUTE FUNCTION public.did_daily_cycle_phase_jobs_set_updated_at();

-- =========================================================================
-- Stale guard: mark running jobs with stale heartbeat as failed_retry / failed_permanent
-- =========================================================================
CREATE OR REPLACE FUNCTION public.did_phase_jobs_sweep_stale()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retry int := 0;
  v_perm int := 0;
BEGIN
  WITH stale AS (
    SELECT id, attempt_count, max_attempts
    FROM public.did_daily_cycle_phase_jobs
    WHERE status = 'running'
      AND COALESCE(last_heartbeat_at, started_at, updated_at) < now() - interval '15 minutes'
    FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE public.did_daily_cycle_phase_jobs j
    SET
      status = CASE WHEN s.attempt_count + 1 >= s.max_attempts THEN 'failed_permanent' ELSE 'failed_retry' END,
      error_message = COALESCE(j.error_message, '') || ' | stale_heartbeat_swept_at=' || now()::text,
      next_retry_at = CASE WHEN s.attempt_count + 1 >= s.max_attempts THEN NULL ELSE now() + interval '2 minutes' END,
      updated_at = now()
    FROM stale s
    WHERE j.id = s.id
    RETURNING j.status
  )
  SELECT
    COUNT(*) FILTER (WHERE status = 'failed_retry'),
    COUNT(*) FILTER (WHERE status = 'failed_permanent')
    INTO v_retry, v_perm
  FROM upd;

  RETURN jsonb_build_object('failed_retry', v_retry, 'failed_permanent', v_perm, 'swept_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.did_phase_jobs_sweep_stale() FROM public, anon, authenticated;
