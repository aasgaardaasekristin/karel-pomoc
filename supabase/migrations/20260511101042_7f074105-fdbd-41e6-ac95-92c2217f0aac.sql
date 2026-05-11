-- P33.5B.2: DB-backed internal edge POST transport.
-- Phase worker uses this to delegate critical downstream calls via pg_net
-- + vault-backed cron secret, bypassing edge-runtime fetch header propagation.
create or replace function public.did_internal_edge_function_post(
  p_function_name text,
  p_body jsonb default '{}'::jsonb,
  p_source text default 'phase_worker',
  p_timeout_ms integer default 120000
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_url text;
  v_request_id bigint;
begin
  if p_function_name not in (
    'run-daily-card-updates',
    'karel-pantry-flush-to-drive',
    'karel-drive-queue-processor',
    'update-operative-plan',
    'karel-daily-therapist-intelligence',
    'karel-did-session-finalize'
  ) then
    raise exception 'function_not_allowed_for_internal_delegate: %', p_function_name;
  end if;

  v_secret := public.get_karel_cron_secret();
  if v_secret is null or length(v_secret) = 0 then
    raise exception 'missing_karel_cron_secret';
  end if;

  v_url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/' || p_function_name;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Karel-Cron-Secret', v_secret,
      'x-karel-cron-secret', v_secret,
      'x-cron-secret', v_secret
    ),
    body := coalesce(p_body, '{}'::jsonb),
    timeout_milliseconds := p_timeout_ms
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.did_internal_edge_function_post(text,jsonb,text,integer) from public;
grant execute on function public.did_internal_edge_function_post(text,jsonb,text,integer) to service_role;