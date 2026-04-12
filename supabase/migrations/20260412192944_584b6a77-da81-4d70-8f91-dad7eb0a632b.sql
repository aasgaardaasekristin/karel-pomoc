ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS clinical_summary text;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS stable_since timestamptz;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS trigger_resolved boolean DEFAULT false;