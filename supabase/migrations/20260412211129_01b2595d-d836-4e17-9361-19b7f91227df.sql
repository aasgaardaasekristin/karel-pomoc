-- Add crisis_event_id to crisis_daily_assessments
ALTER TABLE public.crisis_daily_assessments
ADD COLUMN crisis_event_id UUID REFERENCES public.crisis_events(id) ON DELETE SET NULL;

CREATE INDEX idx_daily_assessments_crisis_event ON public.crisis_daily_assessments(crisis_event_id)
WHERE crisis_event_id IS NOT NULL;

-- Add crisis_event_id to crisis_closure_checklist
ALTER TABLE public.crisis_closure_checklist
ADD COLUMN crisis_event_id UUID REFERENCES public.crisis_events(id) ON DELETE SET NULL;

CREATE INDEX idx_closure_checklist_crisis_event ON public.crisis_closure_checklist(crisis_event_id)
WHERE crisis_event_id IS NOT NULL;

-- Backfill: match via crisis_alerts.part_name → crisis_events.part_name
UPDATE public.crisis_daily_assessments AS cda
SET crisis_event_id = ce.id
FROM public.crisis_alerts AS ca
JOIN public.crisis_events AS ce ON UPPER(ca.part_name) = UPPER(ce.part_name)
WHERE cda.crisis_alert_id = ca.id
  AND cda.crisis_event_id IS NULL;

UPDATE public.crisis_closure_checklist AS ccl
SET crisis_event_id = ce.id
FROM public.crisis_alerts AS ca
JOIN public.crisis_events AS ce ON UPPER(ca.part_name) = UPPER(ce.part_name)
WHERE ccl.crisis_alert_id = ca.id
  AND ccl.crisis_event_id IS NULL;

-- Also backfill pending questions
UPDATE public.did_pending_questions AS dpq
SET crisis_event_id = ce.id
FROM public.crisis_events AS ce
WHERE dpq.crisis_event_id IS NULL
  AND dpq.subject_type IN ('crisis_closure', 'crisis_followup', 'crisis_assessment')
  AND UPPER(COALESCE(dpq.subject_id, '')) = UPPER(ce.part_name)
  AND ce.phase != 'closed';