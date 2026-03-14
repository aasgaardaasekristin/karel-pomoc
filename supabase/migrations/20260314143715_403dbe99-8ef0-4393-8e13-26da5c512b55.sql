
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule daily consolidation at 6:00 CET (5:00 UTC)
SELECT cron.schedule(
  'karel-daily-consolidation',
  '0 5 * * *',
  $$
  SELECT extensions.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/karel-daily-consolidation',
    body := '{}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    )
  );
  $$
);
