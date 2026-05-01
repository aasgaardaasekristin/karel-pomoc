CREATE OR REPLACE FUNCTION public.invoke_briefing_watchdog_acceptance_rebuild(
  p_user_id uuid,
  p_reason text DEFAULT 'acceptance_e2e_after_opening_repair'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net
AS $$
DECLARE
  v_secret text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret
    INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'KAREL_CRON_SECRET'
  LIMIT 1;

  IF COALESCE(v_secret, '') = '' THEN
    RAISE EXCEPTION 'missing_karel_cron_secret' USING ERRCODE = 'P0001';
  END IF;

  SELECT net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-did-briefing-sla-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Karel-Cron-Secret', v_secret
    ),
    body := jsonb_build_object(
      'userId', p_user_id,
      'force_rebuild', true,
      'reason', p_reason,
      'method', 'sla_watchdog_repair',
      'fullAi', true
    )
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_briefing_watchdog_acceptance_rebuild(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_briefing_watchdog_acceptance_rebuild(uuid, text) TO service_role;