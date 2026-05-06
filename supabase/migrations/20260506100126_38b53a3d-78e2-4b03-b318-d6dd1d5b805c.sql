INSERT INTO did_daily_cycle_phase_jobs (user_id, phase_name, job_kind, idempotency_key, priority, max_attempts, input, status, next_retry_at)
VALUES (
  '8a7816ee-4fd1-43d4-8d83-4230d7517ae1',
  'phase5_revize_05ab',
  'phase5_revize_05ab',
  'p29b3_h5_smoke_' || extract(epoch from now())::text,
  'normal', 3,
  '{"dry_run":true,"apply_output":false,"max_items":10,"source":"p29b3_h5_dry_run_smoke"}'::jsonb,
  'queued',
  now()
);