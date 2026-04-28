CREATE UNIQUE INDEX IF NOT EXISTS karel_pantry_b_entries_playroom_dedupe_idx
ON public.karel_pantry_b_entries (source_kind, source_ref, entry_kind, COALESCE(related_part_name, ''))
WHERE source_ref IS NOT NULL AND source_kind = 'playroom';