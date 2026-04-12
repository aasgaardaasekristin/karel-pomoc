
-- Add crisis_event_id to crisis_tasks
ALTER TABLE public.crisis_tasks
ADD COLUMN crisis_event_id uuid REFERENCES public.crisis_events(id);

-- Backfill: match via crisis_alerts.part_name → crisis_events.part_name
UPDATE public.crisis_tasks ct
SET crisis_event_id = ce.id
FROM public.crisis_alerts ca, public.crisis_events ce
WHERE ct.crisis_alert_id = ca.id
  AND ce.part_name = ca.part_name
  AND ct.crisis_event_id IS NULL;
