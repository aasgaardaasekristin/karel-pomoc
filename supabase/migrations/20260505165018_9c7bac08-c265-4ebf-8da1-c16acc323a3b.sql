-- P29B.2: daily-cycle stale sweeper RPC + cron
CREATE OR REPLACE FUNCTION public.did_daily_cycles_sweep_stale()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH swept AS (
    UPDATE public.did_update_cycles
    SET
      status = 'failed_stale',
      last_error = 'daily_cycle_stale_heartbeat_timeout',
      completed_at = now(),
      context_data = COALESCE(context_data, '{}'::jsonb) || jsonb_build_object(
        'stale_sweep', jsonb_build_object(
          'swept_at', now(),
          'reason', 'heartbeat_timeout',
          'last_phase', phase,
          'last_phase_step', phase_step
        )
      )
    WHERE status = 'running'
      AND completed_at IS NULL
      AND COALESCE(last_heartbeat_at, started_at) < now() - interval '20 minutes'
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM swept;
  RETURN jsonb_build_object('swept', v_count, 'at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.did_daily_cycles_sweep_stale() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.did_daily_cycles_sweep_stale() TO service_role;

-- Cron every 5 minutes
DO $$
BEGIN
  PERFORM cron.unschedule('did_daily_cycles_sweep_stale_5min');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

SELECT cron.schedule(
  'did_daily_cycles_sweep_stale_5min',
  '*/5 * * * *',
  $cron$ SELECT public.did_daily_cycles_sweep_stale(); $cron$
);