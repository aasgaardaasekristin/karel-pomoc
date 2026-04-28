CREATE TABLE IF NOT EXISTS public.did_event_ingestion_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_table TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_id TEXT,
  message_id TEXT,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  processed_at TIMESTAMP WITH TIME ZONE,
  processed_by TEXT,
  status TEXT NOT NULL DEFAULT 'captured',
  classification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_kind TEXT,
  evidence_level TEXT,
  related_part_name TEXT,
  author_role TEXT,
  author_name TEXT,
  source_surface TEXT,
  raw_excerpt TEXT,
  clinical_relevance BOOLEAN NOT NULL DEFAULT false,
  operational_relevance BOOLEAN NOT NULL DEFAULT false,
  pantry_entry_id UUID,
  observation_id UUID,
  task_id UUID,
  drive_package_id UUID,
  drive_write_id UUID,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT did_event_ingestion_status_check CHECK (status IN ('captured','classified','routed','skipped','failed','duplicate')),
  CONSTRAINT did_event_ingestion_dedupe UNIQUE (user_id, source_ref, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_did_event_ingestion_user_status ON public.did_event_ingestion_log(user_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_did_event_ingestion_source ON public.did_event_ingestion_log(source_table, source_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_did_event_ingestion_processed ON public.did_event_ingestion_log(processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_did_event_ingestion_related_part ON public.did_event_ingestion_log(related_part_name) WHERE related_part_name IS NOT NULL;

ALTER TABLE public.did_event_ingestion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own did ingestion log" ON public.did_event_ingestion_log;
CREATE POLICY "Users can read own did ingestion log"
ON public.did_event_ingestion_log
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own did ingestion log" ON public.did_event_ingestion_log;
CREATE POLICY "Users can create own did ingestion log"
ON public.did_event_ingestion_log
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own did ingestion log" ON public.did_event_ingestion_log;
CREATE POLICY "Users can update own did ingestion log"
ON public.did_event_ingestion_log
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.did_event_ingestion_cursors (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  source_name TEXT NOT NULL,
  last_processed_at TIMESTAMP WITH TIME ZONE,
  last_processed_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT did_event_ingestion_cursors_unique UNIQUE (user_id, source_name)
);

CREATE INDEX IF NOT EXISTS idx_did_event_ingestion_cursors_user_source ON public.did_event_ingestion_cursors(user_id, source_name);

ALTER TABLE public.did_event_ingestion_cursors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own did ingestion cursors" ON public.did_event_ingestion_cursors;
CREATE POLICY "Users can read own did ingestion cursors"
ON public.did_event_ingestion_cursors
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own did ingestion cursors" ON public.did_event_ingestion_cursors;
CREATE POLICY "Users can create own did ingestion cursors"
ON public.did_event_ingestion_cursors
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own did ingestion cursors" ON public.did_event_ingestion_cursors;
CREATE POLICY "Users can update own did ingestion cursors"
ON public.did_event_ingestion_cursors
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.did_event_ingestion_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS did_event_ingestion_log_set_updated_at ON public.did_event_ingestion_log;
CREATE TRIGGER did_event_ingestion_log_set_updated_at
BEFORE UPDATE ON public.did_event_ingestion_log
FOR EACH ROW
EXECUTE FUNCTION public.did_event_ingestion_set_updated_at();

DROP TRIGGER IF EXISTS did_event_ingestion_cursors_set_updated_at ON public.did_event_ingestion_cursors;
CREATE TRIGGER did_event_ingestion_cursors_set_updated_at
BEFORE UPDATE ON public.did_event_ingestion_cursors
FOR EACH ROW
EXECUTE FUNCTION public.did_event_ingestion_set_updated_at();