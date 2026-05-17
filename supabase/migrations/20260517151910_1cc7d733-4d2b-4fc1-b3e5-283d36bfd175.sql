INSERT INTO public.system_config (key, value, note, updated_at)
VALUES (
  'crisis_enabled',
  'false',
  'FIX 1.8 — Crisis funkce zapouzdřeny. Karel s crisis aktuálně neumí pracovat. Bude rework v FIX 7 (Clinical Comprehension Layer). Nezapínat bez audit.',
  now()
)
ON CONFLICT (key) DO UPDATE SET
  value = 'false',
  note = EXCLUDED.note,
  updated_at = now();