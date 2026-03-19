
-- 1. Add theme_config and thread_emoji to did_threads
ALTER TABLE public.did_threads 
  ADD COLUMN IF NOT EXISTS theme_config jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS thread_emoji text DEFAULT '';

-- 2. Create did_part_theme_preferences for silent mapping
CREATE TABLE public.did_part_theme_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  theme_preset text NOT NULL DEFAULT '',
  theme_config jsonb DEFAULT '{}'::jsonb,
  thread_id uuid REFERENCES public.did_threads(id) ON DELETE SET NULL,
  chosen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_part_theme_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own theme prefs" ON public.did_part_theme_preferences FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can read own theme prefs" ON public.did_part_theme_preferences FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own theme prefs" ON public.did_part_theme_preferences FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3. Create did_part_profiles for psychological profiling
CREATE TABLE public.did_part_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  personality_traits jsonb DEFAULT '[]'::jsonb,
  cognitive_profile jsonb DEFAULT '{}'::jsonb,
  emotional_profile jsonb DEFAULT '{}'::jsonb,
  needs jsonb DEFAULT '[]'::jsonb,
  motivations jsonb DEFAULT '[]'::jsonb,
  strengths jsonb DEFAULT '[]'::jsonb,
  challenges jsonb DEFAULT '[]'::jsonb,
  interests jsonb DEFAULT '[]'::jsonb,
  communication_style jsonb DEFAULT '{}'::jsonb,
  therapeutic_approach jsonb DEFAULT '{}'::jsonb,
  theme_preferences jsonb DEFAULT '{}'::jsonb,
  confidence_score numeric DEFAULT 0.3,
  evidence_sources jsonb DEFAULT '[]'::jsonb,
  last_enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, part_name)
);

ALTER TABLE public.did_part_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own profiles" ON public.did_part_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can read own profiles" ON public.did_part_profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profiles" ON public.did_part_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own profiles" ON public.did_part_profiles FOR DELETE TO authenticated USING (auth.uid() = user_id);
