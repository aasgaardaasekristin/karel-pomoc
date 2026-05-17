-- FIX 8.1: Schema foundation for Hanka full architecture v1 (retry)

-- STEP 0: helper trigger function for updated_at on hana_drive_snapshot
CREATE OR REPLACE FUNCTION public.hana_drive_snapshot_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- STEP 1: hana_personal_memory — 3 new columns
-- ============================================================
ALTER TABLE public.hana_personal_memory
  ADD COLUMN IF NOT EXISTS topic_tags text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS drive_target_file text,
  ADD COLUMN IF NOT EXISTS drive_write_status text NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_hana_memory_topic_tags
  ON public.hana_personal_memory USING GIN (topic_tags)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_hana_memory_drive_pending
  ON public.hana_personal_memory (user_id, drive_write_status)
  WHERE drive_write_status = 'pending';

-- ============================================================
-- STEP 2: hana_personal_identity_audit — 5 new columns
-- ============================================================
ALTER TABLE public.hana_personal_identity_audit
  ADD COLUMN IF NOT EXISTS response_guard_status text,
  ADD COLUMN IF NOT EXISTS cross_contamination_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS segments_classified jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS patientizing_pattern_hit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS karel_role_per_segment jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================
-- STEP 3: did_pending_drive_writes — 3 new columns + UNIQUE partial index
-- ============================================================
ALTER TABLE public.did_pending_drive_writes
  ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'did_part',
  ADD COLUMN IF NOT EXISTS hana_target_file text,
  ADD COLUMN IF NOT EXISTS payload_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_did_pending_drive_target_hash
  ON public.did_pending_drive_writes (target_document, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- ============================================================
-- STEP 4: hana_drive_snapshot
-- ============================================================
CREATE TABLE IF NOT EXISTS public.hana_drive_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  file_name text NOT NULL,
  content text,
  content_hash text,
  file_modified_at timestamptz,
  last_read_at timestamptz,
  last_successful_at timestamptz,
  read_status text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, file_name)
);

ALTER TABLE public.hana_drive_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access_hana_drive_snapshot" ON public.hana_drive_snapshot;
CREATE POLICY "service_role_full_access_hana_drive_snapshot"
  ON public.hana_drive_snapshot
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_hana_drive_snapshot_user
  ON public.hana_drive_snapshot (user_id, file_name);

CREATE INDEX IF NOT EXISTS idx_hana_drive_snapshot_last_ok
  ON public.hana_drive_snapshot (user_id, last_successful_at DESC)
  WHERE read_status = 'ok';

DROP TRIGGER IF EXISTS trg_hana_drive_snapshot_updated_at ON public.hana_drive_snapshot;
CREATE TRIGGER trg_hana_drive_snapshot_updated_at
  BEFORE UPDATE ON public.hana_drive_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION public.hana_drive_snapshot_set_updated_at();

-- ============================================================
-- STEP 5: Quarantine pre-step + audit log
-- ============================================================
DO $$
DECLARE
  v_old_part_name text;
  v_old_display_name text;
  v_remaining int;
BEGIN
  SELECT part_name, display_name INTO v_old_part_name, v_old_display_name
  FROM public.did_part_registry
  WHERE id = 'acfe38b9-edf4-428f-ae58-19b248ac95f5';

  IF FOUND THEN
    UPDATE public.did_part_registry
    SET part_name    = 'QUARANTINED_HANA_' || id::text,
        display_name = 'QUARANTINED_HANA_' || id::text,
        updated_at   = now()
    WHERE id = 'acfe38b9-edf4-428f-ae58-19b248ac95f5';

    INSERT INTO public.karel_runtime_audit_logs (
      runtime_packet_id, function_name, has_multimodal_input, has_drive_sync,
      evaluation_status, metadata
    ) VALUES (
      'fix_8_1_' || gen_random_uuid()::text,
      'fix_8_1_migration',
      false, false, 'ok',
      jsonb_build_object(
        'event_type', 'fix_8_1_did_part_registry_quarantine_rename',
        'event_source', 'fix_8_1_migration',
        'row_id', 'acfe38b9-edf4-428f-ae58-19b248ac95f5',
        'old_part_name', v_old_part_name,
        'old_display_name', v_old_display_name,
        'new_part_name', 'QUARANTINED_HANA_acfe38b9-edf4-428f-ae58-19b248ac95f5',
        'new_display_name', 'QUARANTINED_HANA_acfe38b9-edf4-428f-ae58-19b248ac95f5',
        'reason', 'Hanicka neni DID cast (terapeutka). CHECK constraint did_part_registry_no_hana pridan FIX 8.1.',
        'quarantine_code_preserved', 'quarantined_wrong_identity_p32',
        'severity', 'info'
      )
    );
  END IF;

  SELECT count(*) INTO v_remaining
  FROM public.did_part_registry
  WHERE lower(coalesce(part_name,''))    IN ('hana','hanicka','hanička')
     OR lower(coalesce(display_name,'')) IN ('hana','hanicka','hanička');

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'FIX 8.1 BLOCKER: % rows still match Hana lookup after quarantine; aborting before CHECK constraint.', v_remaining;
  END IF;
END $$;

-- ============================================================
-- STEP 6: CHECK constraint
-- ============================================================
ALTER TABLE public.did_part_registry
  DROP CONSTRAINT IF EXISTS did_part_registry_no_hana;

ALTER TABLE public.did_part_registry
  ADD CONSTRAINT did_part_registry_no_hana
  CHECK (
    lower(coalesce(part_name, ''))    NOT IN ('hana','hanicka','hanička')
    AND lower(coalesce(display_name, '')) NOT IN ('hana','hanicka','hanička')
  );

-- ============================================================
-- STEP 7: Smoke Test 6
-- ============================================================
DO $$
DECLARE
  v_test_user uuid := '00000000-0000-0000-0000-000000000000';
  v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.did_part_registry (user_id, part_name, display_name)
    VALUES (v_test_user, 'Hanička', 'Hanička');
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    DELETE FROM public.did_part_registry
    WHERE user_id = v_test_user AND part_name = 'Hanička';
    RAISE EXCEPTION 'FIX 8.1 SMOKE TEST 6 FAILED: CHECK constraint neblokoval INSERT Hanicka.';
  END IF;

  INSERT INTO public.karel_runtime_audit_logs (
    runtime_packet_id, function_name, has_multimodal_input, has_drive_sync,
    evaluation_status, metadata
  ) VALUES (
    'fix_8_1_smoke6_' || gen_random_uuid()::text,
    'fix_8_1_migration',
    false, false, 'ok',
    jsonb_build_object(
      'event_type', 'fix_8_1_smoke_test_6_passed',
      'event_source', 'fix_8_1_migration',
      'test', 'INSERT did_part_registry (part_name=Hanicka) raised check_violation as expected',
      'severity', 'info'
    )
  );
END $$;