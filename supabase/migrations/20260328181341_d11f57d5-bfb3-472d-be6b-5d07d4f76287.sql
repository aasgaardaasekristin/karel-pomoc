CREATE TABLE public.card_cleanup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  duplicates_removed integer DEFAULT 0,
  tests_removed integer DEFAULT 0,
  redistributions_integrated integer DEFAULT 0,
  moved_to_other_card integer DEFAULT 0,
  moved_entity_names text[] DEFAULT '{}',
  cleanup_summary text,
  user_id uuid DEFAULT auth.uid()
);

ALTER TABLE public.card_cleanup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage cleanup logs"
ON public.card_cleanup_log
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);