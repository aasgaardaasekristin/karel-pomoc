-- P33.5B.3: complete the four delegate jobs using their late 2xx responses.
update did_daily_cycle_phase_jobs set
  status = 'completed',
  completed_at = now(),
  error_message = null,
  result = jsonb_build_object(
    'transport','db','reconciled_late_response',true,
    'db_transport_request_id', 77863,'http_status',200,
    'body', '{"success":true,"partsProcessed":0,"partsSkipped":0,"totalParts":0}'::jsonb)
where cycle_id='b20ff61a-3724-40f4-bf89-7a66c10a2f7c' and job_kind='phase4_card_profiling';

update did_daily_cycle_phase_jobs set
  status='completed', completed_at=now(), error_message=null,
  result=jsonb_build_object('transport','db','reconciled_late_response',true,
    'db_transport_request_id',77865,'http_status',200,
    'body','{"success":true,"partsProcessed":0,"partsSkipped":0,"totalParts":0}'::jsonb)
where cycle_id='b20ff61a-3724-40f4-bf89-7a66c10a2f7c' and job_kind='phase6_card_autoupdate';

update did_daily_cycle_phase_jobs set
  status='completed', completed_at=now(), error_message=null,
  result=jsonb_build_object('transport','db','reconciled_late_response',true,
    'db_transport_request_id',77744,'http_status',200,
    'body','{"ok":true,"mode":"batch","flushed":0,"failed":8,"total_seen":8}'::jsonb)
where cycle_id='b20ff61a-3724-40f4-bf89-7a66c10a2f7c' and job_kind='phase8b_pantry_flush'
  and status in ('failed_retry','failed_permanent','running','queued');

update did_daily_cycle_phase_jobs set
  status='completed', completed_at=now(), error_message=null,
  result=jsonb_build_object('transport','db','reconciled_late_response',true,
    'db_transport_request_id',77751,'http_status',200,
    'body','{"mode":"batch","lane":"bulk","processed":0}'::jsonb)
where cycle_id='b20ff61a-3724-40f4-bf89-7a66c10a2f7c' and job_kind='phase9_drive_queue_flush'
  and status in ('failed_retry','failed_permanent','running','queued');