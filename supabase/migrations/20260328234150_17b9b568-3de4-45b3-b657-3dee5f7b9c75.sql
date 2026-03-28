
CREATE TABLE safety_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text,
  thread_id uuid,
  message_content text,
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  description text,
  detected_signals jsonb DEFAULT '[]',
  recommended_action text,
  status text DEFAULT 'new',
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolution_note text,
  resolved_at timestamptz,
  notification_sent boolean DEFAULT false,
  notification_sent_at timestamptz,
  notification_channel text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_safety_alerts_status ON safety_alerts(status, severity);
CREATE INDEX idx_safety_alerts_part ON safety_alerts(part_name, created_at DESC);
CREATE INDEX idx_safety_alerts_new ON safety_alerts(status) WHERE status = 'new';

ALTER TABLE safety_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_safety_alerts" ON safety_alerts FOR ALL TO authenticated USING (true) WITH CHECK (true);
