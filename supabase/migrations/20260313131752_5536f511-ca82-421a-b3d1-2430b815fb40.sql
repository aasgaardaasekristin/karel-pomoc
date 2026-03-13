
CREATE TABLE public.did_motivation_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  therapist TEXT NOT NULL UNIQUE,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_missed INTEGER NOT NULL DEFAULT 0,
  avg_completion_days NUMERIC(5,2) DEFAULT 0,
  preferred_style TEXT NOT NULL DEFAULT 'balanced',
  praise_effectiveness INTEGER NOT NULL DEFAULT 3,
  deadline_effectiveness INTEGER NOT NULL DEFAULT 3,
  instruction_effectiveness INTEGER NOT NULL DEFAULT 3,
  last_active_at TIMESTAMPTZ DEFAULT now(),
  streak_current INTEGER NOT NULL DEFAULT 0,
  streak_best INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.did_motivation_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profiles" ON public.did_motivation_profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profiles" ON public.did_motivation_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profiles" ON public.did_motivation_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
