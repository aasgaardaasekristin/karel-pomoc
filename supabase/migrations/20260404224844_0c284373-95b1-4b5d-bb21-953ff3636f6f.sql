CREATE TABLE IF NOT EXISTS public.did_task_auto_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.did_therapist_tasks(id) ON DELETE CASCADE,
  part_name text,
  feedback_text text NOT NULL,
  feedback_type text NOT NULL DEFAULT 'completion',
  quality_score int,
  suggestions text[],
  generated_by text DEFAULT 'karel_daily_cycle',
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.did_task_auto_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on did_task_auto_feedback"
  ON public.did_task_auto_feedback FOR ALL
  USING (true) WITH CHECK (true);

CREATE INDEX idx_task_auto_feedback_task
  ON public.did_task_auto_feedback(task_id);

CREATE UNIQUE INDEX idx_task_auto_feedback_unique
  ON public.did_task_auto_feedback(task_id, generated_by);