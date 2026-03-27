
-- Table: crisis_alerts
CREATE TABLE public.crisis_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  conversation_id uuid,
  part_name text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('HIGH', 'CRITICAL')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  summary text NOT NULL,
  trigger_signals text[],
  conversation_excerpts text,
  karel_assessment text,
  intervention_plan text,
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolution_notes text
);

ALTER TABLE public.crisis_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read crisis alerts"
  ON public.crisis_alerts FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Service role can insert crisis alerts"
  ON public.crisis_alerts FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update crisis alerts"
  ON public.crisis_alerts FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Table: crisis_tasks
CREATE TABLE public.crisis_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  crisis_alert_id uuid NOT NULL REFERENCES public.crisis_alerts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  assigned_to text NOT NULL,
  priority text NOT NULL DEFAULT 'CRITICAL',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE')),
  completed_at timestamptz
);

ALTER TABLE public.crisis_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read crisis tasks"
  ON public.crisis_tasks FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Service role can insert crisis tasks"
  ON public.crisis_tasks FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update crisis tasks"
  ON public.crisis_tasks FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.crisis_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.crisis_tasks;
