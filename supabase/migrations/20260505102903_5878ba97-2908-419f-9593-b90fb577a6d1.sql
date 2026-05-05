ALTER TABLE public.did_pending_drive_writes
  ADD COLUMN IF NOT EXISTS rerouted_from_write_id uuid;

CREATE INDEX IF NOT EXISTS idx_dpdw_rerouted_from
  ON public.did_pending_drive_writes (rerouted_from_write_id)
  WHERE rerouted_from_write_id IS NOT NULL;