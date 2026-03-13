
CREATE TABLE public.did_pulse_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  respondent TEXT NOT NULL,
  week_start DATE NOT NULL,
  team_feeling INTEGER NOT NULL CHECK (team_feeling BETWEEN 1 AND 5),
  priority_clarity INTEGER NOT NULL CHECK (priority_clarity BETWEEN 1 AND 5),
  karel_feedback TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (respondent, week_start)
);

ALTER TABLE public.did_pulse_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own pulse checks" ON public.did_pulse_checks FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own pulse checks" ON public.did_pulse_checks FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own pulse checks" ON public.did_pulse_checks FOR UPDATE TO authenticated USING (auth.uid() = user_id);
