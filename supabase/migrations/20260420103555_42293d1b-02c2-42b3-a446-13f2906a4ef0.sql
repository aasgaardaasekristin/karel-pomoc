-- Add retry / error tracking columns to did_pending_drive_writes
ALTER TABLE public.did_pending_drive_writes
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;

-- Indexes for fast lane selection
CREATE INDEX IF NOT EXISTS idx_dpdw_status_priority_created
  ON public.did_pending_drive_writes (status, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_dpdw_pending_next_retry
  ON public.did_pending_drive_writes (next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_dpdw_priority_lane
  ON public.did_pending_drive_writes (priority, status, created_at)
  WHERE status = 'pending';

-- Index on system_health_log for fast watchdog reads
CREATE INDEX IF NOT EXISTS idx_shl_event_type_created
  ON public.system_health_log (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shl_unresolved
  ON public.system_health_log (resolved, severity, created_at DESC)
  WHERE resolved = false;