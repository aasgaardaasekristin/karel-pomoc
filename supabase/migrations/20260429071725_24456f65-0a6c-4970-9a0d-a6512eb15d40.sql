ALTER TABLE public.did_team_deliberations
  ADD COLUMN IF NOT EXISTS approved_program_draft_hash text,
  ADD COLUMN IF NOT EXISTS approved_session_params_hash text,
  ADD COLUMN IF NOT EXISTS approved_program_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.did_daily_session_plans
  ADD COLUMN IF NOT EXISTS started_by uuid,
  ADD COLUMN IF NOT EXISTS start_source text,
  ADD COLUMN IF NOT EXISTS start_audit jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.did_team_delib_approved_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  program_changed boolean;
  params_changed boolean;
  new_program_hash text;
  new_params_hash text;
BEGIN
  new_program_hash := md5(COALESCE(NEW.program_draft::text, '[]'));
  new_params_hash := md5(COALESCE(NEW.session_params::text, '{}'));

  IF NEW.hanka_signed_at IS NOT NULL
     AND NEW.kata_signed_at IS NOT NULL
     AND NEW.status = 'approved' THEN
    IF NEW.approved_program_draft_hash IS NULL THEN
      NEW.approved_program_draft_hash := new_program_hash;
    END IF;
    IF NEW.approved_session_params_hash IS NULL THEN
      NEW.approved_session_params_hash := new_params_hash;
    END IF;
    IF COALESCE(NEW.approved_program_snapshot, '{}'::jsonb) = '{}'::jsonb THEN
      NEW.approved_program_snapshot := jsonb_build_object(
        'program_draft', COALESCE(NEW.program_draft, '[]'::jsonb),
        'session_params', COALESCE(NEW.session_params, '{}'::jsonb),
        'program_draft_hash', new_program_hash,
        'session_params_hash', new_params_hash,
        'signed_at', now()
      );
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'approved'
     AND OLD.hanka_signed_at IS NOT NULL
     AND OLD.kata_signed_at IS NOT NULL THEN
    program_changed := COALESCE(NEW.program_draft, '[]'::jsonb) IS DISTINCT FROM COALESCE(OLD.program_draft, '[]'::jsonb);
    params_changed := COALESCE(NEW.session_params, '{}'::jsonb) IS DISTINCT FROM COALESCE(OLD.session_params, '{}'::jsonb);

    IF program_changed OR params_changed THEN
      NEW.hanka_signed_at := NULL;
      NEW.kata_signed_at := NULL;
      NEW.karel_signed_at := NULL;
      NEW.status := 'in_revision';
      NEW.approved_program_draft_hash := NULL;
      NEW.approved_session_params_hash := NULL;
      NEW.approved_program_snapshot := jsonb_build_object(
        'requires_reapproval', true,
        'invalidated_at', now(),
        'reason', 'approved_program_changed_after_signoff',
        'previous_program_draft_hash', OLD.approved_program_draft_hash,
        'previous_session_params_hash', OLD.approved_session_params_hash
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_did_team_delib_approved_snapshot_guard ON public.did_team_deliberations;
CREATE TRIGGER trg_did_team_delib_approved_snapshot_guard
BEFORE INSERT OR UPDATE OF hanka_signed_at, kata_signed_at, status, program_draft, session_params
ON public.did_team_deliberations
FOR EACH ROW
EXECUTE FUNCTION public.did_team_delib_approved_snapshot_guard();

CREATE OR REPLACE FUNCTION public.sync_and_start_approved_daily_plan(
  p_deliberation_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  result jsonb;
BEGIN
  SELECT * INTO delib
  FROM public.did_team_deliberations
  WHERE id = p_deliberation_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF delib.id IS NULL THEN
    result := jsonb_build_object('ok', false, 'error_code', 'missing_canonical_deliberation', 'message', 'Kanonická porada nebyla nalezena.');
    RETURN result;
  END IF;

  IF delib.deliberation_type <> 'session_plan' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Porada není plán sezení.');
  END IF;

  IF delib.hanka_signed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_hanka_signature', 'message', 'Chybí podpis Haničky.');
  END IF;
  IF delib.kata_signed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_kata_signature', 'message', 'Chybí podpis Káti.');
  END IF;
  IF delib.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'deliberation_not_approved', 'message', 'Porada ještě není schválená.');
  END IF;

  plan_id := delib.linked_live_session_id;
  IF plan_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Chybí navázaný denní plán.');
  END IF;

  SELECT * INTO plan_row
  FROM public.did_daily_session_plans
  WHERE id = plan_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF plan_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Navázaný denní plán nebyl nalezen.');
  END IF;

  IF delib.linked_live_session_id IS DISTINCT FROM plan_row.id THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_not_linked_to_deliberation', 'message', 'Denní plán není kanonicky navázaný na poradu.');
  END IF;

  current_program_hash := md5(COALESCE(delib.program_draft::text, '[]'));
  approved_program_hash := COALESCE(delib.approved_program_draft_hash, current_program_hash);
  current_params_hash := md5(COALESCE(delib.session_params::text, '{}'));
  approved_params_hash := COALESCE(delib.approved_session_params_hash, current_params_hash);

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
  END IF;

  IF current_program_hash <> approved_program_hash OR current_params_hash <> approved_params_hash THEN
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
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_not_linked_to_deliberation', 'message', 'Approval metadata ukazují na jinou poradu.');
  END IF;
  IF existing_program_hash IS NOT NULL AND existing_program_hash <> current_program_hash THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash schváleného programu nesedí.');
  END IF;
  IF existing_markdown_hash IS NOT NULL AND existing_markdown_hash <> md5(COALESCE(plan_row.plan_markdown, '')) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_markdown_hash_mismatch', 'message', 'Hash propsaného denního plánu nesedí.');
  END IF;

  plan_text := '# Schválený plán z týmové porady' || E'\n\n' || COALESCE(delib.program_draft::text, delib.agenda_outline::text, '[]');
  markdown_hash := md5(plan_text);

  approved_for_child := NOT is_playroom
    OR COALESCE((existing_contract->>'approved_for_child_session')::boolean, false)
    OR COALESCE((existing_contract #>> '{approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((existing_contract #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((existing_contract #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false)
    OR (delib.hanka_signed_at IS NOT NULL AND delib.kata_signed_at IS NOT NULL);

  IF is_playroom AND approved_for_child = false THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'approved_for_child_session_missing', 'message', 'Herna nemá schválení pro dětskou místnost.');
  END IF;

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
    ELSE COALESCE(NULLIF(sp->>'session_format', ''), plan_row.session_format, 'osobně')
  END;
  selected_part_value := COALESCE(NULLIF(sp->>'part_name', ''), CASE WHEN array_length(delib.subject_parts, 1) > 0 THEN delib.subject_parts[1] ELSE NULL END, plan_row.selected_part, '(neurčeno)');

  IF lower(COALESCE(plan_row.status, '')) = 'in_progress'
     OR lower(COALESCE(plan_row.lifecycle_status, '')) = 'in_progress'
     OR plan_row.started_at IS NOT NULL THEN
    UPDATE public.did_daily_session_plans
    SET start_audit = COALESCE(start_audit, '{}'::jsonb) || jsonb_build_object(
          'deliberation_id', delib.id::text,
          'plan_id', plan_row.id::text,
          'user_id', p_user_id::text,
          'started_by', p_user_id::text,
          'sync_source', 'sync_and_start_approved_daily_plan',
          'program_draft_hash', current_program_hash,
          'plan_markdown_hash', md5(COALESCE(plan_row.plan_markdown, '')),
          'result', 'already_started',
          'checked_at', now_ts
        ),
        updated_at = now_ts
    WHERE id = plan_row.id;
    RETURN jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'already_started', true, 'started', false);
  END IF;

  IF COALESCE(approval_sync->>'status', '') <> '' AND COALESCE(approval_sync->>'status', '') <> 'synced' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', 'Approval sync existuje, ale není ve stavu synced.');
  END IF;

  merged_contract := existing_contract
    || jsonb_build_object(
      'source', 'team_deliberation',
      'deliberation_id', delib.id::text,
      'program_source', 'program_draft',
      'human_review_required', true,
      'review_state', 'approved',
      'approved_at', COALESCE(plan_row.approved_at, now_ts),
      'approval', COALESCE(existing_contract->'approval', '{}'::jsonb) || jsonb_build_object(
        'review_required', true,
        'was_required', true,
        'review_fulfilled', true,
        'review_state', 'approved',
        'approved_at', COALESCE(plan_row.approved_at, now_ts),
        'signed_by', jsonb_build_array('hanka', 'kata'),
        'approved_for_child_session', is_playroom
      ),
      'approval_sync', jsonb_build_object(
        'status', 'synced',
        'source', 'sync_and_start_approved_daily_plan',
        'synced_at', now_ts,
        'deliberation_id', delib.id::text,
        'program_draft_hash', current_program_hash,
        'approved_program_draft_hash', approved_program_hash,
        'session_params_hash', current_params_hash,
        'plan_markdown_hash', markdown_hash,
        'review_required', true,
        'review_fulfilled', true
      )
    )
    || CASE WHEN is_playroom THEN jsonb_build_object('approved_for_child_session', true, 'mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') ELSE '{}'::jsonb END;

  UPDATE public.did_daily_session_plans
  SET selected_part = selected_part_value,
      plan_markdown = plan_text,
      urgency_breakdown = merged_contract,
      therapist = therapist_value,
      session_lead = session_lead_value,
      session_format = session_format_value,
      generated_by = 'team_deliberation',
      program_status = 'ready_to_start',
      approved_at = COALESCE(approved_at, now_ts),
      ready_to_start_at = COALESCE(ready_to_start_at, now_ts),
      updated_at = now_ts
  WHERE id = plan_row.id;

  SELECT * INTO plan_row
  FROM public.did_daily_session_plans
  WHERE id = plan_id
    AND user_id = p_user_id
  FOR UPDATE;

  approval_sync := COALESCE(plan_row.urgency_breakdown->'approval_sync', '{}'::jsonb);
  IF plan_row.program_status NOT IN ('approved', 'ready_to_start') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_status_not_approved', 'message', 'Program není ve schváleném stavu.');
  END IF;
  IF plan_row.approved_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_status_not_approved', 'message', 'Chybí čas schválení programu.');
  END IF;
  IF approval_sync->>'status' <> 'synced' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'approval_sync_missing', 'message', 'Approval sync chybí.');
  END IF;
  IF approval_sync->>'program_draft_hash' <> current_program_hash THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash programu po synchronizaci nesedí.');
  END IF;
  IF approval_sync->>'plan_markdown_hash' <> md5(COALESCE(plan_row.plan_markdown, '')) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'plan_markdown_hash_mismatch', 'message', 'Hash plánu po synchronizaci nesedí.');
  END IF;

  UPDATE public.did_daily_session_plans
  SET status = 'in_progress',
      lifecycle_status = 'in_progress',
      program_status = 'in_progress',
      started_at = COALESCE(started_at, now_ts),
      started_by = p_user_id,
      start_source = 'sync_and_start_approved_daily_plan',
      start_audit = COALESCE(start_audit, '{}'::jsonb) || jsonb_build_object(
        'deliberation_id', delib.id::text,
        'plan_id', plan_row.id::text,
        'user_id', p_user_id::text,
        'started_by', p_user_id::text,
        'sync_source', 'sync_and_start_approved_daily_plan',
        'program_draft_hash', current_program_hash,
        'approved_program_draft_hash', approved_program_hash,
        'session_params_hash', current_params_hash,
        'plan_markdown_hash', md5(COALESCE(plan_row.plan_markdown, '')),
        'result', 'started',
        'was_missing_sync', was_missing_sync,
        'started_at', now_ts
      ),
      updated_at = now_ts
  WHERE id = plan_row.id;

  RETURN jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'started', true, 'synced', true, 'was_missing_sync', was_missing_sync);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', SQLERRM);
END;
$function$;