CREATE TABLE public.did_therapist_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  task text NOT NULL,
  assigned_to text NOT NULL DEFAULT 'both',
  status text NOT NULL DEFAULT 'pending',
  note text DEFAULT '',
  completed_note text DEFAULT '',
  source_agreement text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  due_date date,
  priority text DEFAULT 'normal',
  category text DEFAULT 'general'
);

ALTER TABLE public.did_therapist_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own therapist tasks" ON public.did_therapist_tasks
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own therapist tasks" ON public.did_therapist_tasks
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own therapist tasks" ON public.did_therapist_tasks
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own therapist tasks" ON public.did_therapist_tasks
  FOR DELETE TO authenticated USING (auth.uid() = user_id);