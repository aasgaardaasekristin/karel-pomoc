-- SLICE 3: First-class briefing items s linked_briefing_item_id pro deliberations.
-- decisions a proposed_session získávají stabilní id v briefing payloadu;
-- did_team_deliberations se na ně váže přes linked_briefing_id + linked_briefing_item_id.
-- Idempotence: druhý klik na stejný briefing item najde existující deliberation
-- přes (linked_briefing_id, linked_briefing_item_id) lookup, ne přes fuzzy text.

ALTER TABLE public.did_team_deliberations
  ADD COLUMN IF NOT EXISTS linked_briefing_id uuid NULL,
  ADD COLUMN IF NOT EXISTS linked_briefing_item_id text NULL,
  ADD COLUMN IF NOT EXISTS agenda_outline jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Index pro rychlý idempotency lookup
CREATE INDEX IF NOT EXISTS idx_did_team_delib_briefing_item
  ON public.did_team_deliberations (linked_briefing_item_id)
  WHERE linked_briefing_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_did_team_delib_briefing
  ON public.did_team_deliberations (linked_briefing_id)
  WHERE linked_briefing_id IS NOT NULL;