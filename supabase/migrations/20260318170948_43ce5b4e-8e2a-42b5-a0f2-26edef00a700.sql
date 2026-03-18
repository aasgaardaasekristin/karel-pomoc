ALTER TABLE public.did_update_cycles 
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS phase_step text DEFAULT '',
  ADD COLUMN IF NOT EXISTS progress_current integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text DEFAULT '';