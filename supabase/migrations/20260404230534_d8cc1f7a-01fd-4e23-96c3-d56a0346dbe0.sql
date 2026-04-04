CREATE TABLE IF NOT EXISTS public.therapist_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_name text NOT NULL UNIQUE,
  strengths text[],
  preferred_methods text[],
  preferred_part_types text[],
  communication_style text,
  experience_areas text[],
  limitations text[],
  workload_capacity text DEFAULT 'normal',
  last_updated timestamptz DEFAULT now(),
  generated_by text DEFAULT 'karel',
  raw_analysis text
);

ALTER TABLE public.therapist_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on therapist_profiles"
  ON public.therapist_profiles FOR ALL
  USING (true) WITH CHECK (true);