-- P33.5B.3 runtime: seed db_transport_request_id into prior failed jobs so the
-- reconciliation helper can pick up the late 2xx response we already have.
update did_daily_cycle_phase_jobs
set
  result = jsonb_build_object(
    'transport', 'db',
    'db_transport_request_id', case job_kind
      when 'phase4_card_profiling' then 77741
      when 'phase6_card_autoupdate' then 77743
      when 'phase8b_pantry_flush' then 77744
      when 'phase9_drive_queue_flush' then 77751
    end,
    'reseed_for_reconciliation', true
  ),
  status = 'queued',
  next_retry_at = now(),
  attempt_count = 0,
  error_message = null
where cycle_id = 'b20ff61a-3724-40f4-bf89-7a66c10a2f7c'
  and job_kind in (
    'phase4_card_profiling',
    'phase6_card_autoupdate',
    'phase8b_pantry_flush',
    'phase9_drive_queue_flush'
  )
  and status in ('failed_retry','failed_permanent');