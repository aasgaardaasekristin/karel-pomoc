CREATE TABLE ai_error_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller text NOT NULL,
  error_type text NOT NULL,
  error_message text,
  raw_input text,
  raw_output text,
  context jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_ai_error_log_caller ON ai_error_log(caller, created_at DESC);
CREATE INDEX idx_ai_error_log_type ON ai_error_log(error_type, created_at DESC);

ALTER TABLE ai_error_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_ai_error_log" ON ai_error_log FOR ALL TO authenticated USING (true);