
CREATE TABLE part_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  goal_text text NOT NULL,
  description text,
  category text DEFAULT 'therapeutic',
  status text DEFAULT 'proposed',
  progress_pct integer DEFAULT 0,
  milestones jsonb DEFAULT '[]',
  proposed_by text DEFAULT 'karel',
  approved_by text,
  approved_at timestamptz,
  completed_at timestamptz,
  last_evaluated_at timestamptz,
  evaluation_notes text,
  priority text DEFAULT 'normal',
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_part_goals_part ON part_goals(part_name, status);
CREATE INDEX idx_part_goals_status ON part_goals(status, priority);

ALTER TABLE part_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_part_goals" ON part_goals FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE goal_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES part_goals(id) ON DELETE CASCADE,
  previous_progress integer,
  new_progress integer,
  evaluation_text text,
  evidence jsonb DEFAULT '[]',
  evaluated_by text DEFAULT 'daily_cycle',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_goal_evaluations_goal ON goal_evaluations(goal_id, created_at DESC);

ALTER TABLE goal_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_goal_evaluations" ON goal_evaluations FOR ALL TO authenticated USING (true) WITH CHECK (true);
