-- Add drive_doc_id and drive_doc_url to clients
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS drive_doc_id text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS drive_doc_url text DEFAULT NULL;

-- Create session_preps table
CREATE TABLE IF NOT EXISTS public.session_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  session_number int,
  plan_content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.session_preps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own session_preps" ON public.session_preps
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read own session_preps" ON public.session_preps
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can update own session_preps" ON public.session_preps
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own session_preps" ON public.session_preps
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Add material_ids to client_sessions
ALTER TABLE public.client_sessions
  ADD COLUMN IF NOT EXISTS material_ids uuid[] DEFAULT '{}'::uuid[];