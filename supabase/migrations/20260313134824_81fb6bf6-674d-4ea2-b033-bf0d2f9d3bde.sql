
CREATE TABLE public.did_kartoteka_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  health_score integer NOT NULL DEFAULT 0,
  missing_sections text[] NOT NULL DEFAULT '{}',
  stale_sections text[] NOT NULL DEFAULT '{}',
  stub_sections text[] NOT NULL DEFAULT '{}',
  total_sections integer NOT NULL DEFAULT 13,
  filled_sections integer NOT NULL DEFAULT 0,
  folder_label text NOT NULL DEFAULT 'AKTIVNÍ',
  last_checked timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_kartoteka_health ADD CONSTRAINT did_kartoteka_health_user_part_unique UNIQUE (user_id, part_name);

ALTER TABLE public.did_kartoteka_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own health checks"
  ON public.did_kartoteka_health FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own health checks"
  ON public.did_kartoteka_health FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own health checks"
  ON public.did_kartoteka_health FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own health checks"
  ON public.did_kartoteka_health FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
