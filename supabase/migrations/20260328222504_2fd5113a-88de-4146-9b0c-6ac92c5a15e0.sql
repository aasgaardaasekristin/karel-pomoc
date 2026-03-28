CREATE TABLE session_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  session_date timestamptz DEFAULT now(),
  thread_id text,
  key_points text[] NOT NULL DEFAULT '{}',
  emotional_state text,
  topics text[] DEFAULT '{}',
  unresolved text[] DEFAULT '{}',
  promises text[] DEFAULT '{}',
  risk_signals text[] DEFAULT '{}',
  positive_signals text[] DEFAULT '{}',
  session_mode text,
  session_duration_msgs int DEFAULT 0,
  auto_generated boolean DEFAULT true,
  manually_edited boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_session_memory_part ON session_memory(part_name, session_date DESC);
CREATE INDEX idx_session_memory_date ON session_memory(session_date DESC);

ALTER TABLE session_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_session_memory" ON session_memory FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE karel_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  promise_text text NOT NULL,
  context text,
  status text DEFAULT 'active',
  source_session_id uuid REFERENCES session_memory(id),
  fulfilled_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE karel_promises ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_promises" ON karel_promises FOR ALL TO authenticated USING (true) WITH CHECK (true);