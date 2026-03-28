CREATE TABLE switching_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id text NOT NULL,
  original_part text NOT NULL,
  detected_part text NOT NULL,
  confidence text DEFAULT 'medium',
  signals jsonb DEFAULT '{}',
  message_index int,
  user_message_excerpt text,
  karel_response text,
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_switching_thread ON switching_events(thread_id, created_at DESC);
CREATE INDEX idx_switching_parts ON switching_events(original_part, detected_part);

ALTER TABLE switching_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_switching" ON switching_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_all_switching" ON switching_events FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE did_threads ADD COLUMN IF NOT EXISTS current_detected_part text;