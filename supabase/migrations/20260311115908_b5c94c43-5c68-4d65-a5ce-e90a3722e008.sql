
CREATE TABLE public.research_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  topic text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL DEFAULT 'unknown',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  is_deleted boolean NOT NULL DEFAULT false,
  is_processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.research_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own research threads" ON public.research_threads FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own research threads" ON public.research_threads FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own research threads" ON public.research_threads FOR UPDATE TO public USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own research threads" ON public.research_threads FOR DELETE TO public USING (auth.uid() = user_id);
