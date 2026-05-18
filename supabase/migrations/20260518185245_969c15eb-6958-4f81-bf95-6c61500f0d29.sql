ALTER TABLE public.did_pending_drive_writes
  ADD COLUMN IF NOT EXISTS source_thread_id uuid NULL,
  ADD COLUMN IF NOT EXISTS source_audit_id uuid NULL,
  ADD COLUMN IF NOT EXISTS resolution_kind text NULL,
  ADD COLUMN IF NOT EXISTS resolution_marker text NULL;