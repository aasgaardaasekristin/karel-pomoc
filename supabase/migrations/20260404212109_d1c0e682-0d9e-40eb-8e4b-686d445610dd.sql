ALTER TABLE public.did_part_registry
  ADD COLUMN IF NOT EXISTS next_session_plan TEXT;