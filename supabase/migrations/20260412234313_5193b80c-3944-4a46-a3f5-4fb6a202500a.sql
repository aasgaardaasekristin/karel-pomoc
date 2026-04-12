
-- Extend did_doc_sync_log with unified audit fields
ALTER TABLE public.did_doc_sync_log
  ADD COLUMN IF NOT EXISTS sync_type text DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS crisis_event_id uuid REFERENCES public.crisis_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS user_id uuid;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_doc_sync_log_sync_type ON public.did_doc_sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_doc_sync_log_crisis_event ON public.did_doc_sync_log(crisis_event_id);
CREATE INDEX IF NOT EXISTS idx_doc_sync_log_created ON public.did_doc_sync_log(created_at DESC);

-- Enable RLS
ALTER TABLE public.did_doc_sync_log ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own sync logs"
  ON public.did_doc_sync_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert sync logs"
  ON public.did_doc_sync_log FOR INSERT
  TO authenticated
  WITH CHECK (true);
