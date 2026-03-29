
CREATE TABLE IF NOT EXISTS crisis_daily_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_alert_id UUID NOT NULL REFERENCES crisis_alerts(id),
  assessment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  day_number INT NOT NULL DEFAULT 1,
  part_name TEXT NOT NULL,
  part_interview_summary TEXT,
  part_emotional_state NUMERIC(3,1),
  part_cooperation_level TEXT,
  part_risk_indicators JSONB DEFAULT '[]'::jsonb,
  tests_administered JSONB DEFAULT '[]'::jsonb,
  therapist_hana_input TEXT,
  therapist_hana_observation TEXT,
  therapist_hana_risk_rating INT,
  therapist_kata_input TEXT,
  therapist_kata_observation TEXT,
  therapist_kata_risk_rating INT,
  karel_risk_assessment TEXT,
  karel_reasoning TEXT,
  karel_decision TEXT,
  next_day_plan JSONB DEFAULT '{}'::jsonb,
  assessment_method TEXT DEFAULT 'automatic',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crisis_assessments_alert ON crisis_daily_assessments(crisis_alert_id);
CREATE INDEX IF NOT EXISTS idx_crisis_assessments_date ON crisis_daily_assessments(assessment_date);
CREATE INDEX IF NOT EXISTS idx_crisis_assessments_part ON crisis_daily_assessments(part_name);

CREATE TABLE IF NOT EXISTS crisis_intervention_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_alert_id UUID NOT NULL REFERENCES crisis_alerts(id),
  assessment_id UUID REFERENCES crisis_daily_assessments(id),
  session_type TEXT NOT NULL,
  part_name TEXT NOT NULL,
  thread_id UUID,
  session_summary TEXT,
  key_findings JSONB DEFAULT '[]'::jsonb,
  risk_indicators_found JSONB DEFAULT '[]'::jsonb,
  protective_factors_found JSONB DEFAULT '[]'::jsonb,
  session_outcome TEXT,
  follow_up_needed BOOLEAN DEFAULT true,
  follow_up_notes TEXT,
  conducted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crisis_sessions_alert ON crisis_intervention_sessions(crisis_alert_id);
CREATE INDEX IF NOT EXISTS idx_crisis_sessions_part ON crisis_intervention_sessions(part_name);

ALTER TABLE crisis_alerts ADD COLUMN IF NOT EXISTS resolution_date TIMESTAMPTZ;
ALTER TABLE crisis_alerts ADD COLUMN IF NOT EXISTS days_in_crisis INT DEFAULT 0;
ALTER TABLE crisis_alerts ADD COLUMN IF NOT EXISTS resolution_method TEXT;
ALTER TABLE crisis_alerts ADD COLUMN IF NOT EXISTS resolution_assessment_id UUID;
ALTER TABLE crisis_alerts ADD COLUMN IF NOT EXISTS post_crisis_monitoring_until DATE;

ALTER TABLE crisis_daily_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE crisis_intervention_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_crisis_daily_assessments" ON crisis_daily_assessments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_crisis_intervention_sessions" ON crisis_intervention_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "service_all_crisis_daily_assessments" ON crisis_daily_assessments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_crisis_intervention_sessions" ON crisis_intervention_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE crisis_daily_assessments;
ALTER PUBLICATION supabase_realtime ADD TABLE crisis_intervention_sessions;
