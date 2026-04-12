ALTER TABLE public.did_pending_questions
ADD COLUMN crisis_event_id UUID REFERENCES public.crisis_events(id) ON DELETE SET NULL;

CREATE INDEX idx_pending_questions_crisis_event ON public.did_pending_questions(crisis_event_id)
WHERE crisis_event_id IS NOT NULL;