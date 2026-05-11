select net.http_post(
  url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-did-daily-cycle-phase-worker',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indwc2NhdnVmeXR3dWNxZW1hd3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzM3MTIsImV4cCI6MjA4NTcwOTcxMn0.ILGYK4GRfoMwE7TBTx9_6syIyUZ-OA2q1Km-sc6JMxY',
    'X-Karel-Cron-Secret', public.get_karel_cron_secret()
  ),
  body := '{"batch":10}'::jsonb,
  timeout_milliseconds := 120000
);