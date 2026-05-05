ALTER TABLE public.hana_personal_memory
  ADD COLUMN IF NOT EXISTS memory_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_hana_personal_memory_payload_gin
  ON public.hana_personal_memory USING gin (memory_payload);

CREATE INDEX IF NOT EXISTS idx_hana_personal_memory_thread_active
  ON public.hana_personal_memory (source_thread_id, memory_type)
  WHERE pipeline_state = 'active' AND superseded_at IS NULL;