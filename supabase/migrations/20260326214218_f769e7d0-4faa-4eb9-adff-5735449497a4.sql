
CREATE TABLE IF NOT EXISTS public.did_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  assigned_to TEXT NOT NULL,
  task_type TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  due_date TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  source TEXT,
  related_part TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  response TEXT,
  follow_up_needed BOOLEAN DEFAULT false
);

ALTER TABLE public.did_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own tasks" ON public.did_tasks
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
