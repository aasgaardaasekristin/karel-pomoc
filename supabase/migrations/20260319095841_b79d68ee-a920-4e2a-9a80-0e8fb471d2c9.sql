
CREATE TABLE public.did_task_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES public.did_therapist_tasks(id) ON DELETE CASCADE NOT NULL,
  author text NOT NULL,
  message text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.did_task_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated full access" ON public.did_task_feedback
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
