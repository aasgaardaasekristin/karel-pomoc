-- P11 final: drift cleanup — acknowledge 3 duplicate Tundrupek/animal_suffering impacts
-- created after the previous P11 dedupe. Canonical row 5815448d-... is preserved.
UPDATE public.external_event_impacts
SET acknowledged_at = now(),
    acknowledged_by = 'p11_final_drift_cleanup',
    reason = '[p11_final_drift_acknowledged] ' || reason,
    updated_at = now()
WHERE id IN (
  'e1637455-f3ca-4b0b-bc3b-615db688ebc2',
  '8f7a4ea8-f81b-48cf-a132-da26da0c8513',
  'd7d0e435-ec8d-498a-9362-fe7dc7e570fc'
)
AND acknowledged_at IS NULL;