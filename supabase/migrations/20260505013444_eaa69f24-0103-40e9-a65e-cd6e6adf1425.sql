
-- ── ČÁST B: backfill consumed_by from pantry → event_log ──
UPDATE public.did_event_ingestion_log eil
   SET consumed_by = COALESCE(eil.consumed_by, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'layer', 'briefing',
           'id', p.flush_result->>'briefing_id',
           'via', 'pantry_b',
           'pantry_id', p.id,
           'at', p.processed_at
         )
       ),
       consumed_at = COALESCE(eil.consumed_at, p.processed_at),
       pipeline_state = CASE
         WHEN eil.pipeline_state IN ('drive_written','drive_queued','drive_skipped_governance','drive_failed_unresolved_target','governance_skipped_wrong_target')
           THEN eil.pipeline_state
         ELSE 'consumed_by_briefing'
       END
  FROM public.karel_pantry_b_entries p
 WHERE p.source_ref = eil.source_ref
   AND p.flush_result ? 'briefing_id'
   AND NOT EXISTS (
     SELECT 1
     FROM jsonb_array_elements(COALESCE(eil.consumed_by, '[]'::jsonb)) x
     WHERE x->>'layer' = 'briefing'
       AND x->>'id' = p.flush_result->>'briefing_id'
   );

-- ── ČÁST D: minimal semantic_dedupe_key backfill ──
UPDATE public.did_event_ingestion_log
   SET semantic_dedupe_key = lower(
         COALESCE(source_kind,'') || ':' ||
         COALESCE(evidence_level,'') || ':' ||
         COALESCE(related_part_name,'_global')
       )
 WHERE semantic_dedupe_key IS NULL;

UPDATE public.karel_pantry_b_entries
   SET semantic_dedupe_key = lower(
         COALESCE(source_kind,'') || ':' ||
         COALESCE(entry_kind,'') || ':' ||
         COALESCE(related_part_name,'_global')
       )
 WHERE semantic_dedupe_key IS NULL;

UPDATE public.hana_personal_memory
   SET semantic_dedupe_key = lower(
         COALESCE(memory_type,'') || ':' ||
         COALESCE(emotional_state,'_unspecified')
       )
 WHERE semantic_dedupe_key IS NULL;

UPDATE public.card_update_queue
   SET semantic_dedupe_key = lower(
         COALESCE(part_id,'_global') || ':' ||
         COALESCE(section,'_global')
       )
 WHERE semantic_dedupe_key IS NULL;

-- ── ČÁST C: re-queue the two stuck 05E writes for Hana personal events ──
-- Those writes belong to therapist_factual_correction events, which should go to part cards
-- (when related_part_name is set) or to the safe notes destination (otherwise).
WITH stuck AS (
  SELECT pdw.id AS write_id, eil.id AS log_id, eil.user_id, eil.related_part_name,
         pdw.content, pdw.write_type, pdw.priority
    FROM public.did_pending_drive_writes pdw
    JOIN public.did_event_ingestion_log eil ON eil.drive_write_id = pdw.id
   WHERE pdw.target_document = 'KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG'
     AND eil.source_kind = 'hana_personal_ingestion'
     AND pdw.status IN ('pending','failed_permanent')
), inserted AS (
  INSERT INTO public.did_pending_drive_writes
    (user_id, target_document, content, write_type, priority, status, pipeline_state, dedupe_key)
  SELECT s.user_id,
         CASE WHEN s.related_part_name IS NOT NULL AND btrim(s.related_part_name) <> ''
              THEN 'KARTA_' || upper(s.related_part_name)
              ELSE 'KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna'
         END,
         s.content, s.write_type, s.priority, 'pending', 'drive_queued',
         md5(s.content || COALESCE(s.related_part_name,'_safe'))
  FROM stuck s
  RETURNING id, target_document
)
UPDATE public.did_pending_drive_writes pdw
   SET status = 'skipped',
       pipeline_state = 'governance_skipped_wrong_target',
       last_error_message = COALESCE(pdw.last_error_message,'') ||
         ' | re-routed by P28_A_B_2 (Hana personal therapist_factual_correction must not write to 05E_TEAM_DECISIONS_LOG)'
  FROM stuck
 WHERE pdw.id = stuck.write_id;

-- Reflect re-routing in event ingestion log (rebind drive_write_id to a re-queued one when possible)
UPDATE public.did_event_ingestion_log eil
   SET pipeline_state = 'drive_queued',
       drive_write_id = pdw.id
  FROM public.did_pending_drive_writes pdw
 WHERE eil.source_kind = 'hana_personal_ingestion'
   AND eil.evidence_level = 'therapist_factual_correction'
   AND eil.pipeline_state IN ('drive_failed_unresolved_target','drive_queued')
   AND pdw.status = 'pending'
   AND pdw.pipeline_state = 'drive_queued'
   AND ( (eil.related_part_name IS NOT NULL AND pdw.target_document = 'KARTA_' || upper(eil.related_part_name))
      OR (eil.related_part_name IS NULL AND pdw.target_document = 'KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna') )
   AND pdw.created_at > now() - interval '2 minutes';
