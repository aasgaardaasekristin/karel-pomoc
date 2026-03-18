ALTER TABLE public.did_update_cycles
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phase_detail text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS context_data jsonb NOT NULL DEFAULT '{}'::jsonb;