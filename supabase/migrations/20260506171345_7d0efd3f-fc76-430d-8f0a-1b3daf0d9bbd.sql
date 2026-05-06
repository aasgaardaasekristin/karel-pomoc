-- P29B.3-H8.2: durable background scheduler for force-full daily cycle.
-- Uses pg_net to POST to karel-did-daily-cycle as a true background HTTP
-- request. Returns the pg_net request id so the launcher can record it in
-- did_update_cycles.context_data.background_request_id.
create or replace function public.did_schedule_daily_cycle_background(
  p_cycle_id uuid,
  p_body jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_url text;
  v_request_id bigint;
  v_body jsonb;
begin
  v_secret := public.get_karel_cron_secret();
  if v_secret is null or length(v_secret) = 0 then
    raise exception 'KAREL_CRON_SECRET_UNAVAILABLE';
  end if;
  v_url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-did-daily-cycle';
  v_body := coalesce(p_body, '{}'::jsonb)
    || jsonb_build_object(
      'existing_cycle_id', p_cycle_id::text,
      'background_orchestrator', true,
      'forceFullPath', true,
      'forceFullAnalysis', true,
      '_bg', true,
      'p29b3_h8_2_durable_scheduler', true
    );
  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Karel-Cron-Secret', v_secret
    ),
    body := v_body,
    timeout_milliseconds := 60000
  ) into v_request_id;
  return jsonb_build_object(
    'request_id', v_request_id,
    'scheduled_at', now()
  );
end;
$$;

revoke all on function public.did_schedule_daily_cycle_background(uuid, jsonb) from public;
grant execute on function public.did_schedule_daily_cycle_background(uuid, jsonb) to service_role;