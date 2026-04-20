-- Recovery: mark stuck daily-cycle run as failed so next cron iteration can start fresh
UPDATE public.did_update_cycles
SET status = 'failed',
    completed_at = now(),
    last_error = 'manual_recovery_stuck_audit_0b_struct_no_keepalive_heartbeat'
WHERE id = 'b89bb836-aa23-4181-821a-e7eec23a71fe'
  AND status = 'running';