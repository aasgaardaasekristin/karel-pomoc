CREATE TABLE public.did_system_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  system_identity text NOT NULL DEFAULT '',
  inner_world_description text NOT NULL DEFAULT '',
  inner_world_rules text NOT NULL DEFAULT '',
  relationships_map jsonb NOT NULL DEFAULT '[]'::jsonb,
  education_context text NOT NULL DEFAULT '',
  goals_short_term text[] NOT NULL DEFAULT '{}',
  goals_mid_term text[] NOT NULL DEFAULT '{}',
  goals_long_term text[] NOT NULL DEFAULT '{}',
  part_contributions jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_priorities text[] NOT NULL DEFAULT '{}',
  integration_strategy text NOT NULL DEFAULT '',
  risk_factors text[] NOT NULL DEFAULT '{}',
  karel_master_analysis text NOT NULL DEFAULT '',
  drive_document_id text DEFAULT '',
  last_drive_sync timestamptz DEFAULT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.did_system_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own system profile" ON public.did_system_profile
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own system profile" ON public.did_system_profile
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own system profile" ON public.did_system_profile
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own system profile" ON public.did_system_profile
  FOR DELETE TO authenticated USING (auth.uid() = user_id);