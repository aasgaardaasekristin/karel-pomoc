CREATE TABLE public.card_archive_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id TEXT NOT NULL,
  original_size_kb INTEGER,
  new_size_kb INTEGER,
  archived_sections TEXT[] DEFAULT '{}',
  archived_block_count INTEGER DEFAULT 0,
  archive_file_name TEXT,
  backup_file_name TEXT,
  dry_run BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.card_archive_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on card_archive_log"
  ON public.card_archive_log FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read card_archive_log"
  ON public.card_archive_log FOR SELECT
  TO authenticated USING (true);