ALTER TABLE public.did_event_ingestion_log
  ADD COLUMN IF NOT EXISTS pipeline_state text,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS semantic_dedupe_key text,
  ADD COLUMN IF NOT EXISTS consumed_by jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_source_ref text,
  ADD COLUMN IF NOT EXISTS retention_state text DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_eil_dedupe_key ON public.did_event_ingestion_log(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_eil_semantic_key ON public.did_event_ingestion_log(semantic_dedupe_key);
CREATE INDEX IF NOT EXISTS idx_eil_pipeline_state ON public.did_event_ingestion_log(pipeline_state);
UPDATE public.did_event_ingestion_log SET pipeline_state = CASE
  WHEN status = 'skipped' THEN 'skipped'
  WHEN drive_write_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.did_pending_drive_writes pdw WHERE pdw.id = did_event_ingestion_log.drive_write_id AND pdw.status = 'completed') THEN 'drive_written'
  WHEN drive_write_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.did_pending_drive_writes pdw WHERE pdw.id = did_event_ingestion_log.drive_write_id AND pdw.status = 'pending') THEN 'drive_queued'
  WHEN drive_write_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.did_pending_drive_writes pdw WHERE pdw.id = did_event_ingestion_log.drive_write_id AND pdw.status = 'skipped') THEN 'drive_skipped_governance'
  WHEN status = 'routed' THEN 'routed'
  ELSE COALESCE(status, 'unknown')
END WHERE pipeline_state IS NULL;
UPDATE public.did_event_ingestion_log SET dedupe_key = COALESCE(source_ref, '') || '|' || COALESCE(event_kind, '')
 WHERE dedupe_key IS NULL AND source_ref IS NOT NULL;

ALTER TABLE public.karel_pantry_b_entries
  ADD COLUMN IF NOT EXISTS pipeline_state text, ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS semantic_dedupe_key text, ADD COLUMN IF NOT EXISTS consumed_by jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz, ADD COLUMN IF NOT EXISTS supersedes_source_ref text,
  ADD COLUMN IF NOT EXISTS retention_state text DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_pantry_dedupe_key ON public.karel_pantry_b_entries(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_pantry_pipeline_state ON public.karel_pantry_b_entries(pipeline_state);
CREATE INDEX IF NOT EXISTS idx_pantry_briefing_consumed ON public.karel_pantry_b_entries((flush_result->>'briefing_id'));
UPDATE public.karel_pantry_b_entries SET pipeline_state = CASE
  WHEN processed_at IS NOT NULL AND flush_result ? 'briefing_id' THEN 'consumed_by_briefing'
  WHEN processed_at IS NOT NULL THEN 'processed' ELSE 'pending' END WHERE pipeline_state IS NULL;
UPDATE public.karel_pantry_b_entries
   SET dedupe_key = COALESCE(source_ref, '') || '|' || COALESCE(entry_kind, ''),
       consumed_at = CASE WHEN flush_result ? 'briefing_id' THEN processed_at ELSE consumed_at END,
       consumed_by = CASE WHEN flush_result ? 'briefing_id'
         THEN jsonb_build_array(jsonb_build_object('layer','briefing','id', flush_result->>'briefing_id','at', processed_at))
         ELSE consumed_by END
 WHERE dedupe_key IS NULL AND source_ref IS NOT NULL;

ALTER TABLE public.hana_personal_memory
  ADD COLUMN IF NOT EXISTS pipeline_state text DEFAULT 'active', ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS semantic_dedupe_key text, ADD COLUMN IF NOT EXISTS consumed_by jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES public.hana_personal_memory(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retention_state text DEFAULT 'active';
UPDATE public.hana_personal_memory
   SET dedupe_key = md5(COALESCE(source_thread_id::text,'') || '|' || COALESCE(memory_type,'') || '|' ||
         lower(regexp_replace(COALESCE(next_opening_hint,''), '\s+', ' ', 'g')))
 WHERE dedupe_key IS NULL;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, source_thread_id, memory_type, dedupe_key ORDER BY created_at DESC) AS rn
  FROM public.hana_personal_memory WHERE dedupe_key IS NOT NULL)
UPDATE public.hana_personal_memory h
   SET pipeline_state = 'superseded', superseded_at = COALESCE(h.superseded_at, now()), retention_state = 'superseded'
  FROM ranked WHERE h.id = ranked.id AND ranked.rn > 1 AND h.pipeline_state <> 'superseded';
CREATE UNIQUE INDEX IF NOT EXISTS uq_hana_memory_dedupe_active
  ON public.hana_personal_memory(user_id, source_thread_id, memory_type, dedupe_key)
  WHERE pipeline_state = 'active';

ALTER TABLE public.card_update_queue
  ADD COLUMN IF NOT EXISTS pipeline_state text DEFAULT 'pending_therapist_confirmation',
  ADD COLUMN IF NOT EXISTS dedupe_key text, ADD COLUMN IF NOT EXISTS semantic_dedupe_key text;
UPDATE public.card_update_queue
   SET dedupe_key = md5(COALESCE(part_id,'') || '|' || COALESCE(section,'') || '|' || COALESCE(source_thread_id::text,'')),
       pipeline_state = CASE WHEN applied = true THEN 'applied'
         WHEN status = 'pending_therapist_confirmation' THEN 'awaiting_therapist'
         ELSE COALESCE(status, 'pending') END
 WHERE dedupe_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_card_q_dedupe_key ON public.card_update_queue(dedupe_key);

ALTER TABLE public.did_pending_drive_writes
  ADD COLUMN IF NOT EXISTS pipeline_state text, ADD COLUMN IF NOT EXISTS dedupe_key text;
UPDATE public.did_pending_drive_writes SET pipeline_state = CASE
  WHEN status = 'completed' THEN 'drive_written'
  WHEN status = 'pending' AND retry_count >= 3 THEN 'drive_failed_unresolved_target'
  WHEN status = 'pending' THEN 'drive_queued'
  WHEN status = 'skipped' THEN 'drive_skipped_governance'
  ELSE COALESCE(status, 'unknown') END WHERE pipeline_state IS NULL;
UPDATE public.did_pending_drive_writes
   SET dedupe_key = md5(COALESCE(target_document,'') || '|' || md5(COALESCE(content,'')))
 WHERE dedupe_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_pdw_dedupe_key ON public.did_pending_drive_writes(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_pdw_pipeline_state ON public.did_pending_drive_writes(pipeline_state);

CREATE OR REPLACE FUNCTION public.did_lifecycle_state_for_thread(p_thread_id uuid)
RETURNS TABLE (layer text, row_id uuid, source_ref text, message_id text,
  pipeline_state text, dedupe_key text, drive_status text,
  drive_target text, consumed_by jsonb, consumed_at timestamptz,
  retention_state text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'event_ingestion_log'::text, eil.id, eil.source_ref::text, eil.message_id::text,
         eil.pipeline_state, eil.dedupe_key, pdw.status::text, pdw.target_document::text,
         eil.consumed_by, eil.consumed_at, eil.retention_state, eil.created_at
    FROM did_event_ingestion_log eil
    LEFT JOIN did_pending_drive_writes pdw ON pdw.id = eil.drive_write_id
   WHERE eil.source_id::text = p_thread_id::text
  UNION ALL
  SELECT 'pantry_b'::text, p.id, p.source_ref::text, NULL::text,
         p.pipeline_state, p.dedupe_key, (p.flush_result->>'status')::text, NULL::text,
         p.consumed_by, p.consumed_at, p.retention_state, p.created_at
    FROM karel_pantry_b_entries p
   WHERE p.source_ref ILIKE '%' || p_thread_id::text || '%'
  UNION ALL
  SELECT 'hana_memory'::text, h.id, h.source_thread_id::text, NULL::text,
         h.pipeline_state, h.dedupe_key, NULL::text, NULL::text,
         h.consumed_by, h.consumed_at, h.retention_state, h.created_at
    FROM hana_personal_memory h
   WHERE h.source_thread_id = p_thread_id
  UNION ALL
  SELECT 'card_update_queue'::text, c.id, c.source_thread_id::text, NULL::text,
         c.pipeline_state, c.dedupe_key, c.status::text, (c.part_id || '/' || c.section)::text,
         '[]'::jsonb, NULL::timestamptz,
         (CASE WHEN c.applied THEN 'applied' ELSE 'active' END)::text, c.created_at
    FROM card_update_queue c
   WHERE c.source_thread_id = p_thread_id
  ORDER BY 12;
$$;