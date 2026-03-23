ALTER TABLE did_daily_session_plans 
  ADD COLUMN IF NOT EXISTS overdue_days integer NOT NULL DEFAULT 0;