
CREATE TABLE public.plan_update_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_type text NOT NULL,
  parts_included text[] DEFAULT '{}',
  sessions_planned int DEFAULT 0,
  sessions_completed int DEFAULT 0,
  goals_updated int DEFAULT 0,
  web_searches int DEFAULT 0,
  processing_time_ms int,
  error text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.plan_update_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select plan_update_log" ON public.plan_update_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access plan_update_log" ON public.plan_update_log FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.planned_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  therapist text NOT NULL,
  method_name text NOT NULL,
  method_source text,
  priority text DEFAULT 'normal',
  status text DEFAULT 'planned',
  horizon text DEFAULT 'short',
  description text,
  expected_outcome text,
  actual_outcome text,
  scheduled_date date,
  completed_date date,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.planned_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select planned_sessions" ON public.planned_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can update planned_sessions" ON public.planned_sessions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access planned_sessions" ON public.planned_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.strategic_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text,
  goal_text text NOT NULL,
  category text,
  status text DEFAULT 'active',
  progress_pct int DEFAULT 0,
  evidence text[] DEFAULT '{}',
  target_date date,
  achieved_date date,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.strategic_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select strategic_goals" ON public.strategic_goals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can update strategic_goals" ON public.strategic_goals FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access strategic_goals" ON public.strategic_goals FOR ALL TO service_role USING (true) WITH CHECK (true);
