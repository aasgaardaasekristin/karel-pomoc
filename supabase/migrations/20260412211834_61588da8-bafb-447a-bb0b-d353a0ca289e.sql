
-- Add crisis_event_id to crisis_intervention_sessions
ALTER TABLE public.crisis_intervention_sessions
ADD COLUMN crisis_event_id uuid REFERENCES public.crisis_events(id);

-- Backfill: match via crisis_alerts.part_name → crisis_events.part_name
UPDATE public.crisis_intervention_sessions cis
SET crisis_event_id = ce.id
FROM public.crisis_alerts ca, public.crisis_events ce
WHERE cis.crisis_alert_id = ca.id
  AND ce.part_name = ca.part_name
  AND cis.crisis_event_id IS NULL;
