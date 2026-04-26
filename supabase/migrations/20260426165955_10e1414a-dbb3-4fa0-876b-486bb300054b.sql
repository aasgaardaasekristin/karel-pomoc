ALTER TABLE public.crisis_events
ADD COLUMN IF NOT EXISTS closure_readiness_snapshot jsonb,
ADD COLUMN IF NOT EXISTS closure_readiness_checked_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_crisis_events_closure_readiness_checked_at
ON public.crisis_events (closure_readiness_checked_at);