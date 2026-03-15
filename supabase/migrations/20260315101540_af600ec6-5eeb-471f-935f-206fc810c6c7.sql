
-- did_part_registry: fast lookup table for DID system parts
-- Auto-populated from episodes, daily cycles, and thread activity
CREATE TABLE public.did_part_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'sleeping', -- active, sleeping, warning, unknown
  cluster text DEFAULT '',
  role_in_system text DEFAULT '',
  age_estimate text DEFAULT '',
  language text DEFAULT 'cs',
  last_seen_at timestamptz,
  last_emotional_state text DEFAULT 'STABILNI',
  last_emotional_intensity integer DEFAULT 3,
  total_episodes integer DEFAULT 0,
  total_threads integer DEFAULT 0,
  health_score integer DEFAULT 0,
  known_triggers text[] DEFAULT '{}',
  known_strengths text[] DEFAULT '{}',
  notes text DEFAULT '',
  drive_folder_label text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, part_name)
);

ALTER TABLE public.did_part_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own part registry" ON public.did_part_registry
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own part registry" ON public.did_part_registry
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own part registry" ON public.did_part_registry
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own part registry" ON public.did_part_registry
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
