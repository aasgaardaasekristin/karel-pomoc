DO $$
DECLARE rid bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-did-daily-cycle',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'X-Karel-Cron-Secret', public.get_karel_cron_secret()
    ),
    body := jsonb_build_object(
      'source','p33_5f_runtime_acceptance_cron_auth',
      'forceFullPath', true,
      'forceFullAnalysis', true,
      'bypassDispatchCheck', true
    ),
    timeout_milliseconds := 60000
  ) INTO rid;
  RAISE NOTICE 'p33_5f_force_request_id=%', rid;
END$$;