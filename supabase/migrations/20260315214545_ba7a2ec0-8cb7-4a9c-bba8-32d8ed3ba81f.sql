
CREATE TABLE public.did_part_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  therapist text NOT NULL DEFAULT 'Hanka',
  session_date date NOT NULL DEFAULT CURRENT_DATE,
  session_type text NOT NULL DEFAULT 'live',
  ai_analysis text DEFAULT '',
  methods_used text[] DEFAULT '{}',
  methods_effectiveness jsonb DEFAULT '{}',
  tasks_assigned jsonb DEFAULT '[]',
  tasks_outcomes jsonb DEFAULT '[]',
  audio_analysis text DEFAULT '',
  image_analysis text DEFAULT '',
  karel_notes text DEFAULT '',
  karel_therapist_feedback text DEFAULT '',
  short_term_goals text[] DEFAULT '{}',
  mid_term_goals text[] DEFAULT '{}',
  long_term_goals text[] DEFAULT '{}',
  thread_id uuid REFERENCES public.did_threads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_part_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own part sessions" ON public.did_part_sessions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can read own part sessions" ON public.did_part_sessions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can update own part sessions" ON public.did_part_sessions FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own part sessions" ON public.did_part_sessions FOR DELETE TO authenticated USING (auth.uid() = user_id);
