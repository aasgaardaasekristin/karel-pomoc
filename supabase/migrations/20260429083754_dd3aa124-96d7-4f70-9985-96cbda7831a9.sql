ALTER TABLE public.did_update_cycles
  ADD COLUMN IF NOT EXISTS phase_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS phase_timeout_seconds integer,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

UPDATE public.did_update_cycles
SET
  phase_started_at = COALESCE(phase_started_at, heartbeat_at, started_at),
  last_heartbeat_at = COALESCE(last_heartbeat_at, heartbeat_at, started_at),
  phase_timeout_seconds = COALESCE(phase_timeout_seconds, 1800)
WHERE cycle_type = 'daily'
  AND (phase_started_at IS NULL OR last_heartbeat_at IS NULL OR phase_timeout_seconds IS NULL);

CREATE INDEX IF NOT EXISTS idx_did_update_cycles_daily_running_heartbeat
ON public.did_update_cycles (cycle_type, status, last_heartbeat_at, started_at)
WHERE cycle_type = 'daily';