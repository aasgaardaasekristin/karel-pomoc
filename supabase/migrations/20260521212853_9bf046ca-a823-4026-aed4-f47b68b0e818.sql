ALTER TABLE public.did_part_registry
  ADD COLUMN IF NOT EXISTS card_format text
  CHECK (card_format IN ('structured', 'legacy_freeform', 'missing'))
  DEFAULT 'structured';

COMMENT ON COLUMN public.did_part_registry.card_format IS
'structured = sekce A-M parseable; legacy_freeform = nejde parsovat; missing = karta nenalezena';