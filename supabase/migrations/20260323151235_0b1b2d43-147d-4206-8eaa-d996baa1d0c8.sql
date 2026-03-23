ALTER TABLE did_daily_session_plans 
  ADD COLUMN IF NOT EXISTS generated_by text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS part_tier text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS session_lead text NOT NULL DEFAULT 'hanka',
  ADD COLUMN IF NOT EXISTS session_format text NOT NULL DEFAULT 'osobně';