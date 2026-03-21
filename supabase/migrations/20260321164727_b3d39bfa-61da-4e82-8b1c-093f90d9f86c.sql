CREATE TABLE public.did_daily_session_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  plan_date date NOT NULL DEFAULT CURRENT_DATE,
  selected_part text NOT NULL,
  urgency_score numeric NOT NULL DEFAULT 0,
  urgency_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_markdown text NOT NULL DEFAULT '',
  plan_html text NOT NULL DEFAULT '',
  therapist text NOT NULL DEFAULT 'hanka',
  status text NOT NULL DEFAULT 'generated',
  distributed_drive boolean NOT NULL DEFAULT false,
  distributed_email boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, plan_date)
);

ALTER TABLE public.did_daily_session_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own plans" ON public.did_daily_session_plans
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own plans" ON public.did_daily_session_plans
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own plans" ON public.did_daily_session_plans
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own plans" ON public.did_daily_session_plans
  FOR DELETE TO authenticated USING (auth.uid() = user_id);