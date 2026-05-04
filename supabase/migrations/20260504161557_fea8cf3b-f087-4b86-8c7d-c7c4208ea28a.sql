DELETE FROM public.did_event_ingestion_log
WHERE user_id = '8a7816ee-4fd1-43d4-8d83-4230d7517ae1'
  AND source_table = 'karel_hana_conversations'
  AND occurred_at >= '2026-05-02'
  AND occurred_at < '2026-05-06';

UPDATE public.did_event_ingestion_cursors
SET last_processed_at = '2026-05-02T00:00:00Z',
    last_processed_id = NULL,
    updated_at = now()
WHERE user_id = '8a7816ee-4fd1-43d4-8d83-4230d7517ae1'
  AND source_name = 'global_did_event_ingestion';