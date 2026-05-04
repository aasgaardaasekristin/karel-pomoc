CREATE OR REPLACE FUNCTION public.invoke_daily_cycle_p23_canary(p_user_id uuid, p_source text DEFAULT 'p23_daily_cycle_canary')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','vault','net'
AS $$
DECLARE
  v_secret text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name='KAREL_CRON_SECRET' LIMIT 1;
  IF COALESCE(v_secret,'') = '' THEN RAISE EXCEPTION 'missing_karel_cron_secret'; END IF;
  SELECT net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-did-daily-cycle',
    headers := jsonb_build_object('Content-Type','application/json','X-Karel-Cron-Secret',v_secret),
    body := jsonb_build_object('source',p_source,'force',true,'userId',p_user_id),
    timeout_milliseconds := 120000
  ) INTO v_request_id;
  RETURN v_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_p23_canary_generic(p_function text, p_body jsonb, p_timeout_ms int DEFAULT 60000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','vault','net'
AS $$
DECLARE
  v_secret text;
  v_request_id bigint;
BEGIN
  IF p_function !~ '^karel-' THEN RAISE EXCEPTION 'function must start with karel-'; END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name='KAREL_CRON_SECRET' LIMIT 1;
  IF COALESCE(v_secret,'') = '' THEN RAISE EXCEPTION 'missing_karel_cron_secret'; END IF;
  SELECT net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/' || p_function,
    headers := jsonb_build_object('Content-Type','application/json','X-Karel-Cron-Secret',v_secret),
    body := p_body,
    timeout_milliseconds := p_timeout_ms
  ) INTO v_request_id;
  RETURN v_request_id;
END;
$$;