
CREATE TABLE public.did_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  topic text NOT NULL,
  agenda text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_summary text DEFAULT '',
  outcome_tasks jsonb DEFAULT '[]'::jsonb,
  triggered_by text DEFAULT 'daily_cycle',
  deadline_at timestamptz DEFAULT (now() + interval '6 hours'),
  hanka_joined_at timestamptz,
  kata_joined_at timestamptz,
  finalized_at timestamptz,
  reminder_sent boolean NOT NULL DEFAULT false
);

ALTER TABLE public.did_meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own meetings" ON public.did_meetings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own meetings" ON public.did_meetings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own meetings" ON public.did_meetings FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own meetings" ON public.did_meetings FOR DELETE TO authenticated USING (auth.uid() = user_id);
