INSERT INTO public.did_daily_cycle_phase_jobs (user_id, phase_name, job_kind, status, max_attempts, idempotency_key, input)
VALUES ('8a7816ee-4fd1-43d4-8d83-4230d7517ae1','phase65_memory_cleanup','phase65_memory_cleanup','queued',1,
  'p29b3_h6_1_smoke_'||extract(epoch from now())::text,
  jsonb_build_object('dry_run',true,'apply_output',false,'max_items',20,'max_age_days',30,'source','p29b3_h6_1_dry_run_smoke'));