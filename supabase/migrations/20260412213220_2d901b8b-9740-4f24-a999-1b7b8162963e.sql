
-- Add crisis_event_id to crisis_journal
ALTER TABLE public.crisis_journal
ADD COLUMN crisis_event_id uuid REFERENCES public.crisis_events(id);

-- Backfill crisis_journal
UPDATE public.crisis_journal cj
SET crisis_event_id = ce.id
FROM public.crisis_alerts ca, public.crisis_events ce
WHERE cj.crisis_alert_id = ca.id
  AND ce.part_name = ca.part_name
  AND cj.crisis_event_id IS NULL;

-- Add crisis_event_id to karel_crisis_research
ALTER TABLE public.karel_crisis_research
ADD COLUMN crisis_event_id uuid REFERENCES public.crisis_events(id);

-- Backfill karel_crisis_research
UPDATE public.karel_crisis_research kcr
SET crisis_event_id = ce.id
FROM public.crisis_alerts ca, public.crisis_events ce
WHERE kcr.crisis_alert_id = ca.id
  AND ce.part_name = ca.part_name
  AND kcr.crisis_event_id IS NULL;
