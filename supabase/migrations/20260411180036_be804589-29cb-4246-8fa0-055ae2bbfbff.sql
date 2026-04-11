
ALTER TABLE public.did_threads
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_status text NOT NULL DEFAULT 'active';

ALTER TABLE public.karel_hana_conversations
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS archive_status text NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_did_threads_lock ON public.did_threads (is_locked, archive_status);
CREATE INDEX IF NOT EXISTS idx_hana_conv_lock ON public.karel_hana_conversations (is_locked, archive_status);
