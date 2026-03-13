
-- Drive write-back queue
CREATE TABLE public.did_pending_drive_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  target_document TEXT NOT NULL,
  write_type TEXT DEFAULT 'append',
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  user_id UUID REFERENCES auth.users(id) DEFAULT auth.uid()
);

ALTER TABLE public.did_pending_drive_writes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own pending writes" ON public.did_pending_drive_writes FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own pending writes" ON public.did_pending_drive_writes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own pending writes" ON public.did_pending_drive_writes FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own pending writes" ON public.did_pending_drive_writes FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Add escalation_level to therapist tasks
ALTER TABLE public.did_therapist_tasks ADD COLUMN IF NOT EXISTS escalation_level INTEGER DEFAULT 0;
