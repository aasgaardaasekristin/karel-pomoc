CREATE TABLE shadow_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist TEXT NOT NULL,
  success BOOLEAN DEFAULT false,
  threads_processed INTEGER DEFAULT 0,
  messages_processed INTEGER DEFAULT 0,
  files_written TEXT[],
  threads_deleted INTEGER DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE shadow_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on shadow_sync_log" ON shadow_sync_log FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated read shadow_sync_log" ON shadow_sync_log FOR SELECT TO authenticated USING (true);