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
  v_anon constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indwc2NhdnVmeXR3dWNxZW1hd3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzM3MTIsImV4cCI6MjA4NTcwOTcxMn0.ILGYK4GRfoMwE7TBTx9_6syIyUZ-OA2q1Km-sc6JMxY';
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
      'Authorization', 'Bearer ' || v_anon,
      'apikey', v_anon,
      'X-Karel-Cron-Secret', v_secret
    ),
    body := coalesce(p_body, '{}'::jsonb),
    timeout_milliseconds := p_timeout_ms
  ) into v_request_id;

  return v_request_id;
end;
$$;