CREATE OR REPLACE FUNCTION public.team_deliberation_signoff_and_sync(
  p_deliberation_id uuid,
  p_user_id uuid,
  p_signer text,
  p_plan_markdown text DEFAULT NULL,
  p_ready_to_start boolean DEFAULT false,
  p_sync_source text DEFAULT 'signoff_sync'
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
BEGIN
  IF p_signer NOT IN ('hanka', 'kata') THEN
    RAISE EXCEPTION 'bad signer' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO delib
  FROM public.did_team_deliberations
  WHERE id = p_deliberation_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF delib.id IS NULL THEN
    RAISE EXCEPTION 'deliberation not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_signer = 'hanka' AND delib.hanka_signed_at IS NULL THEN
    UPDATE public.did_team_deliberations
    SET hanka_signed_at = now_ts
    WHERE id = p_deliberation_id;
  ELSIF p_signer = 'kata' AND delib.kata_signed_at IS NULL THEN
    UPDATE public.did_team_deliberations
    SET kata_signed_at = now_ts
    WHERE id = p_deliberation_id;
  END IF;

  SELECT *
  INTO delib
  FROM public.did_team_deliberations
  WHERE id = p_deliberation_id
  FOR UPDATE;

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

    plan_text := COALESCE(NULLIF(p_plan_markdown, ''), '# Schválený plán z týmové porady' || E'\n\n' || COALESCE(delib.program_draft::text, delib.agenda_outline::text, '[]'));
    program_hash := md5(COALESCE(delib.program_draft::text, '[]'));
    markdown_hash := md5(plan_text);

    IF plan_id IS NOT NULL THEN
      SELECT *
      INTO plan_row
      FROM public.did_daily_session_plans
      WHERE id = plan_id
        AND user_id = p_user_id
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
            'review_required', true,
            'was_required', true,
            'review_fulfilled', true,
            'review_state', 'approved',
            'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced',
            'source', p_sync_source,
            'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true,
            'review_fulfilled', true
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
        user_id,
        plan_date,
        selected_part,
        therapist,
        session_format,
        status,
        urgency_score,
        urgency_breakdown,
        plan_markdown,
        generated_by,
        session_lead,
        program_status,
        approved_at,
        ready_to_start_at
      ) VALUES (
        p_user_id,
        CURRENT_DATE,
        selected_part_value,
        therapist_value,
        session_format_value,
        'generated',
        CASE WHEN delib.priority = 'crisis' THEN 100 ELSE 70 END,
        jsonb_build_object(
          'source', 'team_deliberation',
          'deliberation_id', delib.id::text,
          'program_source', 'program_draft',
          'human_review_required', true,
          'review_state', 'approved',
          'approved_at', now_ts,
          'approved_for_child_session', is_playroom,
          'approval', jsonb_build_object(
            'review_required', true,
            'was_required', true,
            'review_fulfilled', true,
            'review_state', 'approved',
            'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced',
            'source', p_sync_source,
            'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true,
            'review_fulfilled', true
          )
        ) || CASE WHEN is_playroom THEN jsonb_build_object('mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') ELSE '{}'::jsonb END,
        plan_text,
        'team_deliberation',
        session_lead_value,
        CASE WHEN p_ready_to_start THEN 'ready_to_start' ELSE 'approved' END,
        now_ts,
        CASE WHEN p_ready_to_start THEN now_ts ELSE NULL END
      )
      RETURNING id INTO plan_id;

      UPDATE public.did_team_deliberations
      SET linked_live_session_id = plan_id,
          updated_at = now_ts
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
$function$;

CREATE OR REPLACE FUNCTION public.guard_unsigned_daily_session_plan_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  contract jsonb;
  deliberation_id uuid;
  delib record;
  attempts_start boolean;
  approved_for_child boolean;
  human_review_required boolean;
  effective_program_status text;
  is_child_facing_playroom boolean;
  approval_sync jsonb;
  direct_approval_fulfilled boolean;
  canonical_sync_fulfilled boolean := false;
  review_fulfilled boolean;
BEGIN
  contract := COALESCE(NEW.urgency_breakdown, '{}'::jsonb);
  approval_sync := COALESCE(contract->'approval_sync', '{}'::jsonb);
  effective_program_status := lower(COALESCE(NEW.program_status, contract->>'review_state', contract #>> '{approval,review_state}', ''));
  is_child_facing_playroom := contract->>'session_actor' = 'karel_direct'
    OR contract->>'ui_surface' = 'did_kids_playroom'
    OR contract->>'mode' = 'playroom'
    OR contract ? 'playroom_plan';
  approved_for_child := COALESCE((contract->>'approved_for_child_session')::boolean, false)
    OR COALESCE((contract #>> '{approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false);
  human_review_required := COALESCE((contract->>'human_review_required')::boolean, false)
    OR COALESCE((contract #>> '{approval,required}')::boolean, false)
    OR COALESCE((contract #>> '{approval,review_required}')::boolean, false)
    OR COALESCE((contract #>> '{approval,was_required}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,approval,required}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,therapist_review,required}')::boolean, false);

  attempts_start := lower(COALESCE(NEW.status, '')) IN ('in_progress', 'active', 'started')
    OR lower(COALESCE(NEW.lifecycle_status, '')) IN ('in_progress', 'active', 'started')
    OR NEW.started_at IS NOT NULL
    OR NEW.ready_to_start_at IS NOT NULL;

  IF NOT attempts_start THEN
    RETURN NEW;
  END IF;

  IF contract ? 'deliberation_id' THEN
    BEGIN
      deliberation_id := (contract->>'deliberation_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      deliberation_id := NULL;
    END;

    IF deliberation_id IS NULL THEN
      RAISE EXCEPTION 'daily_session_plan_requires_canonical_deliberation_signatures_before_start'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, linked_live_session_id, hanka_signed_at, kata_signed_at, status, program_draft
    INTO delib
    FROM public.did_team_deliberations
    WHERE id = deliberation_id;

    IF delib.id IS NULL
       OR delib.linked_live_session_id IS DISTINCT FROM NEW.id
       OR delib.hanka_signed_at IS NULL
       OR delib.kata_signed_at IS NULL
       OR delib.status <> 'approved' THEN
      RAISE EXCEPTION 'daily_session_plan_requires_canonical_deliberation_signatures_before_start'
        USING ERRCODE = 'check_violation';
    END IF;

    canonical_sync_fulfilled := approval_sync->>'status' = 'synced'
      AND approval_sync->>'deliberation_id' = delib.id::text
      AND approval_sync->>'program_draft_hash' = md5(COALESCE(delib.program_draft::text, '[]'))
      AND approval_sync->>'plan_markdown_hash' = md5(COALESCE(NEW.plan_markdown, ''));
  END IF;

  direct_approval_fulfilled := effective_program_status IN ('approved', 'ready_to_start', 'in_progress', 'completed')
    AND NEW.approved_at IS NOT NULL;
  review_fulfilled := direct_approval_fulfilled OR canonical_sync_fulfilled;

  IF (human_review_required = true AND review_fulfilled = false)
     OR (is_child_facing_playroom AND approved_for_child = false)
     OR (effective_program_status IN ('draft', 'in_revision', 'awaiting_signatures', 'awaiting_signature', 'pending_review') AND canonical_sync_fulfilled = false) THEN
    RAISE EXCEPTION 'daily_session_plan_requires_signatures_before_start'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_unsigned_daily_session_plan_start ON public.did_daily_session_plans;
CREATE TRIGGER guard_unsigned_daily_session_plan_start
BEFORE INSERT OR UPDATE OF status, lifecycle_status, started_at, ready_to_start_at, program_status, urgency_breakdown, plan_markdown
ON public.did_daily_session_plans
FOR EACH ROW
EXECUTE FUNCTION public.guard_unsigned_daily_session_plan_start();