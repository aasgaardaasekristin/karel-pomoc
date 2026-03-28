
CREATE TABLE crisis_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  phase text NOT NULL DEFAULT 'acute',
  severity text NOT NULL DEFAULT 'high',
  trigger_description text NOT NULL,
  trigger_source text,
  indicator_emotional_regulation int DEFAULT 0,
  indicator_safety int DEFAULT 0,
  indicator_coherence int DEFAULT 0,
  indicator_trust int DEFAULT 0,
  indicator_time_orientation int DEFAULT 0,
  diagnostic_session_id text,
  diagnostic_score int,
  diagnostic_report text,
  diagnostic_date timestamptz,
  closure_proposed_at timestamptz,
  closure_proposed_by text DEFAULT 'karel',
  closure_approved_by text[] DEFAULT '{}',
  closure_approved_at timestamptz,
  closure_reason text,
  banner_dismissed boolean DEFAULT false,
  banner_dismissed_at timestamptz,
  sessions_count int DEFAULT 0,
  days_active int DEFAULT 0,
  opened_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE crisis_session_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_id uuid REFERENCES crisis_events(id),
  session_date timestamptz DEFAULT now(),
  session_type text DEFAULT 'therapeutic',
  emotional_regulation_ok boolean DEFAULT false,
  safety_ok boolean DEFAULT false,
  coherence_score int DEFAULT 5,
  trust_level int DEFAULT 5,
  future_mentions boolean DEFAULT false,
  summary text,
  karel_notes text,
  risk_signals text[] DEFAULT '{}',
  positive_signals text[] DEFAULT '{}',
  color_test_result text,
  tree_test_result text,
  projective_story_result text,
  scaling_score int,
  reality_testing_ok boolean,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE crisis_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_session_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_crisis_events" ON crisis_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_update_crisis_events" ON crisis_events FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_insert_crisis_events" ON crisis_events FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "service_all_crisis_events" ON crisis_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "auth_select_crisis_logs" ON crisis_session_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_crisis_logs" ON crisis_session_logs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "service_all_crisis_logs" ON crisis_session_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
