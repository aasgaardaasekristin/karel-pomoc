
-- Add escalated_at and last_escalation_email_at columns
ALTER TABLE public.did_therapist_tasks 
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_escalation_email_at TIMESTAMPTZ;

-- Convert escalation_level from integer to text if needed
ALTER TABLE public.did_therapist_tasks 
  ALTER COLUMN escalation_level TYPE TEXT USING CASE 
    WHEN escalation_level IS NULL THEN NULL
    WHEN escalation_level = 0 THEN 'none'
    WHEN escalation_level = 1 THEN 'warning'
    WHEN escalation_level >= 2 THEN 'critical'
    ELSE 'none'
  END;
