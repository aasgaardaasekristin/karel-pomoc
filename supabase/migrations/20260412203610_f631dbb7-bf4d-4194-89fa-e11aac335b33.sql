ALTER TABLE public.did_meetings ADD COLUMN crisis_event_id uuid REFERENCES public.crisis_events(id) ON DELETE SET NULL;

CREATE INDEX idx_did_meetings_crisis_event_id ON public.did_meetings(crisis_event_id) WHERE crisis_event_id IS NOT NULL;