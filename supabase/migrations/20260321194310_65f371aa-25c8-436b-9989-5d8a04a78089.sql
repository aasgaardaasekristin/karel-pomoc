
CREATE TABLE public.did_supervision_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  period_days INTEGER NOT NULL DEFAULT 14,
  report_markdown TEXT NOT NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.did_supervision_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own reports"
  ON public.did_supervision_reports
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service can insert reports"
  ON public.did_supervision_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());
