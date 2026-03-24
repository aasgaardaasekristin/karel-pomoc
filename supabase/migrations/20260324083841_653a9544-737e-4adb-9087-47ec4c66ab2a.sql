
CREATE TABLE public.did_daily_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  context_date date NOT NULL DEFAULT CURRENT_DATE,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'karel-daily-refresh',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, context_date)
);

ALTER TABLE public.did_daily_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own daily context" ON public.did_daily_context FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own daily context" ON public.did_daily_context FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own daily context" ON public.did_daily_context FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Service can manage daily context" ON public.did_daily_context FOR ALL TO service_role USING (true) WITH CHECK (true);
