-- FIX 1 — Schema migration for did_part_registry
-- 1) Backup
CREATE TABLE IF NOT EXISTS public.did_part_registry_backup_2026_05_16 AS
SELECT * FROM public.did_part_registry;

-- 2) New columns (idempotent)
ALTER TABLE public.did_part_registry
  ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT;

-- 3) Indexes for case-insensitive + alias lookup
CREATE INDEX IF NOT EXISTS did_part_registry_lower_name_idx
  ON public.did_part_registry (user_id, lower(part_name));
CREATE INDEX IF NOT EXISTS did_part_registry_aliases_gin_idx
  ON public.did_part_registry USING gin (aliases);