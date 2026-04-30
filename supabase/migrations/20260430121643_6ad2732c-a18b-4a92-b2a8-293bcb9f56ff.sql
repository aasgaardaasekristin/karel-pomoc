
-- ============================================================================
-- live_session_program_markdown_execution_fix
-- ============================================================================
-- SEV-1 fix: po "Spustit sezení" se v Live DID sezení nezobrazoval program
-- bod po bodu, jen "Bezformátový program — sleduj plán v chatu", protože
-- sync_and_start_approved_daily_plan ukládal do plan_markdown surový JSON
-- dump program_draft místo markdown sekce "## Program sezení".
--
-- Tato migrace:
--   1) přidává sdílený SQL builder build_approved_plan_markdown,
--   2) opravuje sync_and_start_approved_daily_plan (start path),
--   3) opravuje team_deliberation_signoff_and_sync (signoff fallback),
--   4) jednorázově opraví všechny existující rozbité live plány.
-- ============================================================================


-- ──────────────────────────────────────────────────────────────────────────
-- 1) Sdílený SQL builder
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.build_approved_plan_markdown(
  p_delib public.did_team_deliberations
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  source_blocks jsonb;
  sp jsonb;
  led_by text;
  duration_min text;
  part_name text;
  why_today text;
  kata_inv text;
  reason_txt text;
  header_lines text[] := ARRAY[]::text[];
  program_lines text[] := ARRAY[]::text[];
  block jsonb;
  block_title text;
  block_minutes_raw text;
  block_minutes_int int;
  block_detail text;
  emitted_count int := 0;
  i int;
  output text;
BEGIN
  sp := COALESCE(p_delib.session_params, '{}'::jsonb);
  led_by := NULLIF(btrim(COALESCE(sp->>'led_by', '')), '');
  duration_min := NULLIF(btrim(COALESCE(sp->>'duration_min', '')), '');
  part_name := NULLIF(btrim(COALESCE(sp->>'part_name', '')), '');
  why_today := NULLIF(btrim(COALESCE(sp->>'why_today', '')), '');
  kata_inv := NULLIF(btrim(COALESCE(sp->>'kata_involvement', '')), '');
  reason_txt := NULLIF(btrim(COALESCE(p_delib.reason, '')), '');

  -- Source: program_draft preferred, agenda_outline fallback
  IF p_delib.program_draft IS NOT NULL
     AND jsonb_typeof(p_delib.program_draft) = 'array'
     AND jsonb_array_length(p_delib.program_draft) > 0 THEN
    source_blocks := p_delib.program_draft;
  ELSIF p_delib.agenda_outline IS NOT NULL
     AND jsonb_typeof(p_delib.agenda_outline) = 'array'
     AND jsonb_array_length(p_delib.agenda_outline) > 0 THEN
    source_blocks := p_delib.agenda_outline;
  ELSE
    source_blocks := '[]'::jsonb;
  END IF;

  -- Header
  header_lines := array_append(header_lines, '# Schválený plán z týmové porady');
  IF p_delib.title IS NOT NULL AND btrim(p_delib.title) <> '' THEN
    header_lines := array_append(header_lines, format('**Porada:** %s', p_delib.title));
  END IF;
  IF led_by IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Vede:** %s', led_by));
  END IF;
  IF duration_min IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Délka:** ~%s min', duration_min));
  END IF;
  IF part_name IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Část:** %s', part_name));
  END IF;
  IF why_today IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Proč dnes:** %s', why_today));
  END IF;
  IF kata_inv IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Káťa:** %s', kata_inv));
  END IF;
  IF reason_txt IS NOT NULL THEN
    header_lines := array_append(header_lines, format('**Důvod:** %s', reason_txt));
  END IF;
  header_lines := array_append(header_lines, '');

  -- Program section
  program_lines := array_append(program_lines, '## Program sezení');
  program_lines := array_append(program_lines, '');

  IF jsonb_typeof(source_blocks) = 'array' THEN
    FOR i IN 0..(jsonb_array_length(source_blocks) - 1) LOOP
      block := source_blocks->i;

      block_title := NULLIF(btrim(COALESCE(block->>'block', block->>'title', '')), '');
      IF block_title IS NULL THEN
        CONTINUE;
      END IF;

      block_minutes_raw := NULLIF(btrim(COALESCE(block->>'minutes', '')), '');
      block_minutes_int := NULL;
      IF block_minutes_raw IS NOT NULL THEN
        BEGIN
          block_minutes_int := block_minutes_raw::int;
        EXCEPTION WHEN OTHERS THEN
          block_minutes_int := NULL;
        END;
      END IF;

      block_detail := NULLIF(btrim(COALESCE(
        block->>'detail',
        block->>'clinical_intent',
        block->>'playful_form',
        block->>'script',
        ''
      )), '');

      emitted_count := emitted_count + 1;
      IF block_minutes_int IS NOT NULL AND block_minutes_int > 0 THEN
        program_lines := array_append(program_lines,
          format('%s. **%s** (%s min)', emitted_count, block_title, block_minutes_int));
      ELSE
        program_lines := array_append(program_lines,
          format('%s. **%s**', emitted_count, block_title));
      END IF;
      IF block_detail IS NOT NULL THEN
        program_lines := array_append(program_lines, format('   %s', block_detail));
      END IF;
      program_lines := array_append(program_lines, '');
    END LOOP;
  END IF;

  IF emitted_count = 0 THEN
    program_lines := array_append(program_lines,
      'Program zatím není připravený k live spuštění. Chybí validní bloky programu.');
  END IF;

  output := array_to_string(header_lines, E'\n') || E'\n' || array_to_string(program_lines, E'\n');
  RETURN output;
END;
$$;


-- ──────────────────────────────────────────────────────────────────────────
-- 2) Oprava sync_and_start_approved_daily_plan
--    (jediná změněná řádka oproti existující funkci je sestavení plan_text;
--    + přidaný guard, že výsledný markdown obsahuje '## Program sezení')
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_and_start_approved_daily_plan(
  p_deliberation_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  delib public.did_team_deliberations%ROWTYPE;
  plan_row public.did_daily_session_plans%ROWTYPE;
  sp jsonb;
  existing_contract jsonb;
  approval_sync jsonb;
  merged_contract jsonb;
  now_ts timestamptz := now();
  plan_id uuid;
  current_program_hash text;
  approved_program_hash text;
  current_params_hash text;
  approved_params_hash text;
  plan_text text;
  markdown_hash text;
  existing_program_hash text;
  existing_markdown_hash text;
  is_playroom boolean;
  approved_for_child boolean;
  led_by text;
  therapist_value text;
  session_lead_value text;
  session_format_value text;
  selected_part_value text;
  was_missing_sync boolean := false;
  audit_hashes jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO delib
  FROM public.did_team_deliberations
  WHERE id = p_deliberation_id AND user_id = p_user_id
  FOR UPDATE;

  IF delib.id IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    VALUES (p_user_id, p_deliberation_id, p_user_id, 'blocked', 'missing_canonical_deliberation', 'Kanonická porada nebyla nalezena.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_canonical_deliberation', 'message', 'Kanonická porada nebyla nalezena.');
  END IF;

  IF delib.deliberation_type <> 'session_plan' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, p_user_id, 'blocked', 'missing_daily_plan', 'Porada není plán sezení.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Porada není plán sezení.');
  END IF;

  IF delib.hanka_signed_at IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'missing_hanka_signature', 'Chybí podpis Haničky.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_hanka_signature', 'message', 'Chybí podpis Haničky.');
  END IF;
  IF delib.kata_signed_at IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'missing_kata_signature', 'Chybí podpis Káti.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_kata_signature', 'message', 'Chybí podpis Káti.');
  END IF;
  IF delib.status <> 'approved' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'deliberation_not_approved', 'Porada ještě není schválená.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'deliberation_not_approved', 'message', 'Porada ještě není schválená.');
  END IF;

  plan_id := delib.linked_live_session_id;
  IF plan_id IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, p_user_id, 'blocked', 'missing_daily_plan', 'Chybí navázaný denní plán.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Chybí navázaný denní plán.');
  END IF;

  SELECT * INTO plan_row
  FROM public.did_daily_session_plans
  WHERE id = plan_id AND user_id = p_user_id
  FOR UPDATE;

  IF plan_row.id IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_id, p_user_id, 'blocked', 'missing_daily_plan', 'Navázaný denní plán nebyl nalezen.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Navázaný denní plán nebyl nalezen.');
  END IF;

  current_program_hash := md5(COALESCE(delib.program_draft::text, '[]'));
  approved_program_hash := COALESCE(delib.approved_program_draft_hash, current_program_hash);
  current_params_hash := md5(COALESCE(delib.session_params::text, '{}'));
  approved_params_hash := COALESCE(delib.approved_session_params_hash, current_params_hash);
  audit_hashes := jsonb_build_object('program_draft_hash', current_program_hash, 'approved_program_draft_hash', approved_program_hash, 'session_params_hash', current_params_hash);

  IF delib.approved_program_draft_hash IS NULL OR delib.approved_session_params_hash IS NULL THEN
    UPDATE public.did_team_deliberations
    SET approved_program_draft_hash = current_program_hash,
        approved_session_params_hash = current_params_hash,
        approved_program_snapshot = jsonb_build_object(
          'program_draft', COALESCE(delib.program_draft, '[]'::jsonb),
          'session_params', COALESCE(delib.session_params, '{}'::jsonb),
          'program_draft_hash', current_program_hash,
          'session_params_hash', current_params_hash,
          'signed_at', COALESCE(delib.karel_signed_at, delib.updated_at, now_ts),
          'backfilled_at', now_ts
        ),
        updated_at = now_ts
    WHERE id = delib.id;
    approved_program_hash := current_program_hash;
    approved_params_hash := current_params_hash;
    audit_hashes := jsonb_set(audit_hashes, '{approved_program_draft_hash}', to_jsonb(approved_program_hash));
  END IF;

  IF current_program_hash <> approved_program_hash OR current_params_hash <> approved_params_hash THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_hash_mismatch', 'Program se změnil po podpisu a vyžaduje nové schválení.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Program se změnil po podpisu a vyžaduje nové schválení.');
  END IF;

  sp := COALESCE(delib.session_params, '{}'::jsonb);
  led_by := btrim(COALESCE(sp->>'led_by', ''));
  is_playroom := COALESCE(sp->>'session_actor', '') = 'karel_direct'
    OR COALESCE(sp->>'ui_surface', '') = 'did_kids_playroom'
    OR COALESCE(sp->>'session_format', '') = 'playroom'
    OR lower(led_by) LIKE 'kar%';

  existing_contract := COALESCE(plan_row.urgency_breakdown, '{}'::jsonb);
  approval_sync := COALESCE(existing_contract->'approval_sync', '{}'::jsonb);
  was_missing_sync := COALESCE(approval_sync->>'status', '') = '';
  existing_program_hash := approval_sync->>'program_draft_hash';
  existing_markdown_hash := approval_sync->>'plan_markdown_hash';

  IF approval_sync ? 'deliberation_id' AND approval_sync->>'deliberation_id' <> delib.id::text THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'plan_not_linked_to_deliberation', 'Approval metadata ukazují na jinou poradu.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_not_linked_to_deliberation', 'message', 'Approval metadata ukazují na jinou poradu.');
  END IF;
  IF existing_program_hash IS NOT NULL AND existing_program_hash <> current_program_hash THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes || jsonb_build_object('existing_program_draft_hash', existing_program_hash), 'blocked', 'program_hash_mismatch', 'Hash schváleného programu nesedí.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash schváleného programu nesedí.');
  END IF;
  -- Pozn.: existing_markdown_hash check zde úmyslně neporovnáváme — plán se chystáme přepsat
  -- novým buildovaným markdownem (původní mohl být rozbitý JSON dump).

  -- ⭐ FIX: použij sdílený builder místo JSON dumpu
  plan_text := public.build_approved_plan_markdown(delib);

  -- Hard guard: výsledný markdown MUSÍ obsahovat sekci "## Program sezení"
  -- a alespoň jeden očíslovaný blok. Jinak zablokuj start.
  IF plan_text IS NULL OR btrim(plan_text) = '' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_empty', 'Builder vrátil prázdný plán.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_empty', 'message', 'Builder vrátil prázdný plán.');
  END IF;
  IF plan_text NOT ILIKE '%## Program sezení%' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_missing_program_section', 'Schválený plán nemá sekci Program sezení.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_missing_program_section', 'message', 'Schválený plán nemá sekci Program sezení.');
  END IF;
  IF plan_text !~ E'\n1\\.\\s+\\*\\*' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_unparseable', 'Schválený plán neobsahuje očíslované body.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_unparseable', 'message', 'Schválený plán neobsahuje očíslované body.');
  END IF;

  markdown_hash := md5(plan_text);
  audit_hashes := audit_hashes || jsonb_build_object('plan_markdown_hash', markdown_hash);

  approved_for_child := NOT is_playroom
    OR COALESCE((existing_contract->>'approved_for_child_session')::boolean, false)
    OR COALESCE((existing_contract #>> '{approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((existing_contract #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((existing_contract #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false)
    OR COALESCE((sp->>'approved_for_child_session')::boolean, false)
    OR COALESCE((sp #>> '{approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((sp #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((sp #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false);

  IF is_playroom AND approved_for_child = false THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_for_child_session_missing', 'Herna nemá schválení pro dětskou místnost.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'approved_for_child_session_missing', 'message', 'Herna nemá schválení pro dětskou místnost.');
  END IF;

  therapist_value := CASE WHEN is_playroom THEN 'karel' WHEN lower(led_by) LIKE 'ka%' OR lower(led_by) LIKE 'ká%' THEN 'kata' ELSE 'hanka' END;
  session_lead_value := CASE WHEN is_playroom THEN 'karel' WHEN lower(led_by) LIKE 'ka%' OR lower(led_by) LIKE 'ká%' THEN 'kata' WHEN lower(led_by) LIKE 'sp%' THEN 'obe' ELSE 'hanka' END;
  session_format_value := CASE WHEN is_playroom THEN 'playroom' WHEN sp->>'session_format' = 'individual' THEN 'osobně' WHEN sp->>'session_format' = 'joint' THEN 'kombinované' ELSE COALESCE(NULLIF(sp->>'session_format', ''), plan_row.session_format, 'osobně') END;
  selected_part_value := COALESCE(NULLIF(sp->>'part_name', ''), CASE WHEN array_length(delib.subject_parts, 1) > 0 THEN delib.subject_parts[1] ELSE NULL END, plan_row.selected_part, '(neurčeno)');

  IF lower(COALESCE(plan_row.status, '')) = 'in_progress'
     OR lower(COALESCE(plan_row.lifecycle_status, '')) = 'in_progress'
     OR plan_row.started_at IS NOT NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'already_started', 'Plán už běží.');
    UPDATE public.did_daily_session_plans
    SET start_audit = COALESCE(start_audit, '{}'::jsonb) || jsonb_build_object('deliberation_id', delib.id::text, 'plan_id', plan_row.id::text, 'user_id', p_user_id::text, 'started_by', p_user_id::text, 'sync_source', 'sync_and_start_approved_daily_plan', 'approval_hashes', audit_hashes, 'result', 'already_started', 'checked_at', now_ts),
        updated_at = now_ts
    WHERE id = plan_row.id;
    RETURN jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'already_started', true, 'started', false);
  END IF;

  IF COALESCE(approval_sync->>'status', '') <> '' AND COALESCE(approval_sync->>'status', '') <> 'synced' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'sync_failed', 'Approval sync existuje, ale není ve stavu synced.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', 'Approval sync existuje, ale není ve stavu synced.');
  END IF;

  merged_contract := existing_contract
    || jsonb_build_object('source', 'team_deliberation', 'deliberation_id', delib.id::text, 'program_source', 'program_draft', 'human_review_required', true, 'review_state', 'approved', 'approved_at', COALESCE(plan_row.approved_at, now_ts), 'approval', COALESCE(existing_contract->'approval', '{}'::jsonb) || jsonb_build_object('review_required', true, 'was_required', true, 'review_fulfilled', true, 'review_state', 'approved', 'approved_at', COALESCE(plan_row.approved_at, now_ts), 'signed_by', jsonb_build_array('hanka', 'kata'), 'approved_for_child_session', is_playroom), 'approval_sync', jsonb_build_object('status', 'synced', 'source', 'sync_and_start_approved_daily_plan', 'synced_at', now_ts, 'deliberation_id', delib.id::text, 'program_draft_hash', current_program_hash, 'approved_program_draft_hash', approved_program_hash, 'session_params_hash', current_params_hash, 'plan_markdown_hash', markdown_hash, 'review_required', true, 'review_fulfilled', true))
    || CASE WHEN is_playroom THEN jsonb_build_object('approved_for_child_session', true, 'mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') ELSE '{}'::jsonb END;

  UPDATE public.did_daily_session_plans
  SET selected_part = selected_part_value, plan_markdown = plan_text, urgency_breakdown = merged_contract, therapist = therapist_value, session_lead = session_lead_value, session_format = session_format_value, generated_by = 'team_deliberation', program_status = 'ready_to_start', approved_at = COALESCE(approved_at, now_ts), ready_to_start_at = COALESCE(ready_to_start_at, now_ts), updated_at = now_ts
  WHERE id = plan_row.id;

  SELECT * INTO plan_row
  FROM public.did_daily_session_plans
  WHERE id = plan_id AND user_id = p_user_id
  FOR UPDATE;

  approval_sync := COALESCE(plan_row.urgency_breakdown->'approval_sync', '{}'::jsonb);
  IF plan_row.program_status NOT IN ('approved', 'ready_to_start') OR plan_row.approved_at IS NULL THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_status_not_approved', 'Program není ve schváleném stavu.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_status_not_approved', 'message', 'Program není ve schváleném stavu.');
  END IF;
  IF approval_sync->>'status' <> 'synced' THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approval_sync_missing', 'Approval sync chybí.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'approval_sync_missing', 'message', 'Approval sync chybí.');
  END IF;
  IF approval_sync->>'program_draft_hash' <> current_program_hash THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_hash_mismatch', 'Hash programu po synchronizaci nesedí.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash programu po synchronizaci nesedí.');
  END IF;
  IF approval_sync->>'plan_markdown_hash' <> md5(COALESCE(plan_row.plan_markdown, '')) THEN
    INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'plan_markdown_hash_mismatch', 'Hash plánu po synchronizaci nesedí.');
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_markdown_hash_mismatch', 'message', 'Hash plánu po synchronizaci nesedí.');
  END IF;

  UPDATE public.did_daily_session_plans
  SET status = 'in_progress', lifecycle_status = 'in_progress', program_status = 'in_progress', started_at = COALESCE(started_at, now_ts), started_by = p_user_id, start_source = 'sync_and_start_approved_daily_plan', start_audit = COALESCE(start_audit, '{}'::jsonb) || jsonb_build_object('deliberation_id', delib.id::text, 'plan_id', plan_row.id::text, 'user_id', p_user_id::text, 'started_by', p_user_id::text, 'sync_source', 'sync_and_start_approved_daily_plan', 'approval_hashes', audit_hashes, 'result', 'started', 'was_missing_sync', was_missing_sync, 'started_at', now_ts), updated_at = now_ts
  WHERE id = plan_row.id;

  INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, message)
  VALUES (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'started', 'Plán byl bezpečně synchronizován a spuštěn.');

  RETURN jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'started', true, 'synced', true, 'was_missing_sync', was_missing_sync);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
  VALUES (p_user_id, p_deliberation_id, plan_id, p_user_id, audit_hashes, 'error', 'sync_failed', SQLERRM);
  RETURN jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', SQLERRM);
END;
$$;


-- ──────────────────────────────────────────────────────────────────────────
-- 3) Oprava team_deliberation_signoff_and_sync (signoff fallback)
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.team_deliberation_signoff_and_sync(
  p_deliberation_id uuid,
  p_user_id uuid,
  p_signer text,
  p_plan_markdown text DEFAULT NULL::text,
  p_ready_to_start boolean DEFAULT false,
  p_sync_source text DEFAULT 'signoff_sync'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  delib public.did_team_deliberations%ROWTYPE;
  plan_row public.did_daily_session_plans%ROWTYPE;
  sp jsonb;
  old_contract jsonb;
  merged_contract jsonb;
  now_ts timestamptz := now();
  is_playroom boolean;
  plan_id uuid;
  bridge_mode text := 'skipped';
  program_hash text;
  markdown_hash text;
  led_by text;
  therapist_value text;
  session_lead_value text;
  session_format_value text;
  selected_part_value text;
  plan_text text;
  candidate_text text;
BEGIN
  IF p_signer NOT IN ('hanka', 'kata') THEN
    RAISE EXCEPTION 'bad signer' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO delib
  FROM public.did_team_deliberations
  WHERE id = p_deliberation_id AND user_id = p_user_id
  FOR UPDATE;

  IF delib.id IS NULL THEN
    RAISE EXCEPTION 'deliberation not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_signer = 'hanka' AND delib.hanka_signed_at IS NULL THEN
    UPDATE public.did_team_deliberations SET hanka_signed_at = now_ts WHERE id = p_deliberation_id;
  ELSIF p_signer = 'kata' AND delib.kata_signed_at IS NULL THEN
    UPDATE public.did_team_deliberations SET kata_signed_at = now_ts WHERE id = p_deliberation_id;
  END IF;

  SELECT * INTO delib FROM public.did_team_deliberations WHERE id = p_deliberation_id FOR UPDATE;

  plan_id := delib.linked_live_session_id;

  IF delib.status = 'approved' AND delib.deliberation_type = 'session_plan' THEN
    sp := COALESCE(delib.session_params, '{}'::jsonb);
    led_by := btrim(COALESCE(sp->>'led_by', ''));
    is_playroom := COALESCE(sp->>'session_actor', '') = 'karel_direct'
      OR COALESCE(sp->>'ui_surface', '') = 'did_kids_playroom'
      OR COALESCE(sp->>'session_format', '') = 'playroom'
      OR lower(led_by) LIKE 'kar%';

    therapist_value := CASE
      WHEN is_playroom THEN 'karel'
      WHEN lower(led_by) LIKE 'ka%' OR lower(led_by) LIKE 'ká%' THEN 'kata'
      ELSE 'hanka'
    END;
    session_lead_value := CASE
      WHEN is_playroom THEN 'karel'
      WHEN lower(led_by) LIKE 'ka%' OR lower(led_by) LIKE 'ká%' THEN 'kata'
      WHEN lower(led_by) LIKE 'sp%' THEN 'obe'
      ELSE 'hanka'
    END;
    session_format_value := CASE
      WHEN is_playroom THEN 'playroom'
      WHEN sp->>'session_format' = 'individual' THEN 'osobně'
      WHEN sp->>'session_format' = 'joint' THEN 'kombinované'
      ELSE COALESCE(NULLIF(sp->>'session_format', ''), 'osobně')
    END;
    selected_part_value := COALESCE(
      NULLIF(sp->>'part_name', ''),
      CASE WHEN array_length(delib.subject_parts, 1) > 0 THEN delib.subject_parts[1] ELSE NULL END,
      '(neurčeno)'
    );

    -- ⭐ FIX: validuj klientský markdown; pokud je prázdný / nemá Program sezení,
    -- použij sdílený SQL builder.
    candidate_text := NULLIF(btrim(COALESCE(p_plan_markdown, '')), '');
    IF candidate_text IS NOT NULL
       AND candidate_text ILIKE '%## Program sezení%'
       AND candidate_text ~ E'\n1\\.\\s+\\*\\*' THEN
      plan_text := candidate_text;
    ELSE
      plan_text := public.build_approved_plan_markdown(delib);
    END IF;

    program_hash := md5(COALESCE(delib.program_draft::text, '[]'));
    markdown_hash := md5(plan_text);

    IF plan_id IS NOT NULL THEN
      SELECT * INTO plan_row
      FROM public.did_daily_session_plans
      WHERE id = plan_id AND user_id = p_user_id
      FOR UPDATE;
    END IF;

    IF plan_id IS NOT NULL AND plan_row.id IS NOT NULL THEN
      old_contract := COALESCE(plan_row.urgency_breakdown, '{}'::jsonb);
      merged_contract := old_contract
        || jsonb_build_object(
          'source', 'team_deliberation',
          'deliberation_id', delib.id::text,
          'program_source', 'program_draft',
          'human_review_required', true,
          'review_state', 'approved',
          'approved_at', now_ts,
          'approval', COALESCE(old_contract->'approval', '{}'::jsonb) || jsonb_build_object(
            'review_required', true, 'was_required', true, 'review_fulfilled', true,
            'review_state', 'approved', 'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced', 'source', p_sync_source, 'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true, 'review_fulfilled', true
          )
        )
        || CASE WHEN is_playroom THEN jsonb_build_object('approved_for_child_session', true) ELSE '{}'::jsonb END;

      UPDATE public.did_daily_session_plans
      SET plan_markdown = plan_text,
          urgency_breakdown = merged_contract,
          therapist = therapist_value,
          session_lead = session_lead_value,
          session_format = session_format_value,
          generated_by = 'team_deliberation',
          program_status = CASE WHEN p_ready_to_start THEN 'ready_to_start' ELSE 'approved' END,
          approved_at = COALESCE(approved_at, now_ts),
          ready_to_start_at = CASE WHEN p_ready_to_start THEN COALESCE(ready_to_start_at, now_ts) ELSE ready_to_start_at END,
          updated_at = now_ts
      WHERE id = plan_id;
      bridge_mode := 'update';
    ELSE
      INSERT INTO public.did_daily_session_plans (
        user_id, plan_date, selected_part, therapist, session_format, status,
        urgency_score, urgency_breakdown, plan_markdown, generated_by,
        session_lead, program_status, approved_at, ready_to_start_at
      ) VALUES (
        p_user_id, CURRENT_DATE, selected_part_value, therapist_value, session_format_value,
        'generated',
        CASE WHEN delib.priority = 'crisis' THEN 100 ELSE 70 END,
        jsonb_build_object(
          'source', 'team_deliberation', 'deliberation_id', delib.id::text,
          'program_source', 'program_draft', 'human_review_required', true,
          'review_state', 'approved', 'approved_at', now_ts,
          'approved_for_child_session', is_playroom,
          'approval', jsonb_build_object(
            'review_required', true, 'was_required', true, 'review_fulfilled', true,
            'review_state', 'approved', 'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced', 'source', p_sync_source, 'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true, 'review_fulfilled', true
          )
        ) || CASE WHEN is_playroom THEN jsonb_build_object('mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') ELSE '{}'::jsonb END,
        plan_text, 'team_deliberation', session_lead_value,
        CASE WHEN p_ready_to_start THEN 'ready_to_start' ELSE 'approved' END,
        now_ts,
        CASE WHEN p_ready_to_start THEN now_ts ELSE NULL END
      )
      RETURNING id INTO plan_id;

      UPDATE public.did_team_deliberations
      SET linked_live_session_id = plan_id, updated_at = now_ts
      WHERE id = delib.id;
      bridge_mode := 'insert';
    END IF;
  END IF;

  SELECT * INTO delib FROM public.did_team_deliberations WHERE id = p_deliberation_id;

  RETURN jsonb_build_object(
    'deliberation_id', delib.id,
    'deliberation_status', delib.status,
    'bridged_plan_id', plan_id,
    'bridge_mode', bridge_mode
  );
END;
$$;


-- ──────────────────────────────────────────────────────────────────────────
-- 4) Jednorázová oprava existujících rozbitých live plánů
--    + dopočet plan_markdown_hash, aby start guard po opravě prošel
-- ──────────────────────────────────────────────────────────────────────────
WITH repaired AS (
  SELECT
    p.id AS plan_id,
    public.build_approved_plan_markdown(d.*) AS new_md
  FROM public.did_daily_session_plans p
  JOIN public.did_team_deliberations d
    ON d.id::text = p.urgency_breakdown #>> '{approval_sync,deliberation_id}'
  WHERE (
      p.plan_markdown ~ '^\s*# Schválený plán z týmové porady\s*\n\s*\['
      OR p.plan_markdown NOT ILIKE '%## Program sezení%'
    )
    AND (
      p.lifecycle_status IN ('planned','in_progress','active','started')
      OR p.status IN ('generated','approved','ready_to_start','in_progress','active','started')
    )
)
UPDATE public.did_daily_session_plans p
SET plan_markdown = repaired.new_md,
    urgency_breakdown = jsonb_set(
      jsonb_set(
        COALESCE(p.urgency_breakdown, '{}'::jsonb),
        '{approval_sync,plan_markdown_hash}',
        to_jsonb(md5(repaired.new_md)),
        true
      ),
      '{approval_sync,plan_markdown_repaired_at}',
      to_jsonb(now()::text),
      true
    ),
    updated_at = now()
FROM repaired
WHERE p.id = repaired.plan_id
  AND repaired.new_md ILIKE '%## Program sezení%';
