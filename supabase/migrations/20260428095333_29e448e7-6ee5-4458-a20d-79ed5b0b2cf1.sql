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
  canonical_approval_fulfilled boolean := false;
  has_deliberation_contract boolean := false;
  review_fulfilled boolean;
BEGIN
  contract := COALESCE(NEW.urgency_breakdown, '{}'::jsonb);
  approval_sync := COALESCE(contract->'approval_sync', '{}'::jsonb);
  has_deliberation_contract := contract ? 'deliberation_id';
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

  IF has_deliberation_contract THEN
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

    canonical_approval_fulfilled := canonical_sync_fulfilled
      AND effective_program_status IN ('approved', 'ready_to_start', 'in_progress', 'completed')
      AND NEW.approved_at IS NOT NULL;
  END IF;

  direct_approval_fulfilled := NOT has_deliberation_contract
    AND effective_program_status IN ('approved', 'ready_to_start', 'in_progress', 'completed')
    AND NEW.approved_at IS NOT NULL;
  review_fulfilled := direct_approval_fulfilled OR canonical_approval_fulfilled;

  IF (human_review_required = true AND review_fulfilled = false)
     OR (is_child_facing_playroom AND approved_for_child = false)
     OR (has_deliberation_contract AND canonical_approval_fulfilled = false)
     OR effective_program_status IN ('draft', 'in_revision', 'awaiting_signatures', 'awaiting_signature', 'pending_review') THEN
    RAISE EXCEPTION 'daily_session_plan_requires_signatures_before_start'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;