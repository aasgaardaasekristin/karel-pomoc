ALTER TABLE public.did_daily_report_dispatches
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_strategy text DEFAULT '',
  ADD COLUMN IF NOT EXISTS watchdog_log text DEFAULT '';