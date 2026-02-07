
-- Table for storing crisis supervision briefs
CREATE TABLE public.crisis_briefs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  scenario TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  regulation_attempts INTEGER NOT NULL DEFAULT 0,
  regulation_successful BOOLEAN NOT NULL DEFAULT false,
  therapist_bridge_triggered BOOLEAN NOT NULL DEFAULT false,
  therapist_bridge_method TEXT,
  time_dynamics JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT NOT NULL DEFAULT '',
  risk_overview TEXT NOT NULL DEFAULT '',
  recommended_contact TEXT NOT NULL DEFAULT '',
  suggested_opening_lines TEXT[] NOT NULL DEFAULT '{}',
  risk_formulations TEXT[] NOT NULL DEFAULT '{}',
  next_steps TEXT[] NOT NULL DEFAULT '{}',
  raw_brief TEXT NOT NULL DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT false,
  notification_sent BOOLEAN NOT NULL DEFAULT false
);

-- Enable RLS
ALTER TABLE public.crisis_briefs ENABLE ROW LEVEL SECURITY;

-- Public insert policy (anonymous clients create briefs via edge function)
CREATE POLICY "Edge functions can insert crisis briefs"
ON public.crisis_briefs
FOR INSERT
WITH CHECK (true);

-- Public select for now (no auth yet, therapist reads via Karel)
CREATE POLICY "Anyone can read crisis briefs"
ON public.crisis_briefs
FOR SELECT
USING (true);

-- Allow updating is_read status
CREATE POLICY "Anyone can update crisis briefs"
ON public.crisis_briefs
FOR UPDATE
USING (true);
