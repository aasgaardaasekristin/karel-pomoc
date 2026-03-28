CREATE TABLE daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_date date NOT NULL DEFAULT CURRENT_DATE,
  part_name text,
  message_count int DEFAULT 0,
  user_message_count int DEFAULT 0,
  assistant_message_count int DEFAULT 0,
  avg_message_length int DEFAULT 0,
  session_count int DEFAULT 0,
  emotional_valence numeric(3,1),
  emotional_arousal numeric(3,1),
  cooperation_level numeric(3,1),
  openness_level numeric(3,1),
  switching_count int DEFAULT 0,
  risk_signals_count int DEFAULT 0,
  positive_signals_count int DEFAULT 0,
  promises_made int DEFAULT 0,
  promises_fulfilled int DEFAULT 0,
  unresolved_topics int DEFAULT 0,
  new_topics_introduced int DEFAULT 0,
  therapist_notes_count int DEFAULT 0,
  computed_at timestamptz DEFAULT now(),
  source text DEFAULT 'daily_cycle',
  raw_data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  UNIQUE(metric_date, part_name)
);

CREATE INDEX idx_daily_metrics_part ON daily_metrics(part_name, metric_date DESC);
CREATE INDEX idx_daily_metrics_date ON daily_metrics(metric_date DESC);

ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_daily_metrics" ON daily_metrics FOR ALL TO authenticated USING (true) WITH CHECK (true);