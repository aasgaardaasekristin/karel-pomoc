CREATE OR REPLACE FUNCTION public.get_karel_cron_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'KAREL_CRON_SECRET' LIMIT 1;
$$;

SELECT cron.unschedule('karel-active-session-processor-3min');

SELECT cron.schedule(
  'karel-active-session-processor-3min',
  '*/3 * * * *',
  $job$
  select net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-active-session-processor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Karel-Cron-Secret', public.get_karel_cron_secret()
    ),
    body := jsonb_build_object('trigger','cron')
  );
  $job$
);