CREATE OR REPLACE FUNCTION public.guard_unsigned_daily_session_plan_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  contract jsonb;
  deliberation_id uuid;
  delib record;
  attempts_start boolean;
  approved_for_child boolean;
  human_review_required boolean;
  effective_program_status text;
BEGIN
  contract := COALESCE(NEW.urgency_breakdown, '{}'::jsonb);
  effective_program_status := lower(COALESCE(NEW.program_status, contract->>'review_state', contract #>> '{approval,review_state}', ''));
  approved_for_child := COALESCE((contract->>'approved_for_child_session')::boolean, false)
    OR COALESCE((contract #>> '{approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false);
  human_review_required := COALESCE((contract->>'human_review_required')::boolean, false)
    OR COALESCE((contract #>> '{approval,required}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,approval,required}')::boolean, false)
    OR COALESCE((contract #>> '{playroom_plan,therapist_review,required}')::boolean, false);

  attempts_start := lower(COALESCE(NEW.status, '')) IN ('in_progress', 'active', 'started')
    OR lower(COALESCE(NEW.lifecycle_status, '')) IN ('in_progress', 'active', 'started')
    OR NEW.started_at IS NOT NULL
    OR NEW.ready_to_start_at IS NOT NULL;

  IF NOT attempts_start THEN
    RETURN NEW;
  END IF;

  IF human_review_required = true
     OR approved_for_child = false
     OR effective_program_status IN ('draft', 'in_revision', 'awaiting_signatures', 'awaiting_signature', 'pending_review') THEN
    RAISE EXCEPTION 'daily_session_plan_requires_signatures_before_start'
      USING ERRCODE = 'check_violation';
  END IF;

  IF contract ? 'deliberation_id' THEN
    BEGIN
      deliberation_id := (contract->>'deliberation_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      deliberation_id := NULL;
    END;

    IF deliberation_id IS NOT NULL THEN
      SELECT id, hanka_signed_at, kata_signed_at, status
      INTO delib
      FROM public.did_team_deliberations
      WHERE id = deliberation_id;

      IF delib.id IS NULL
         OR delib.hanka_signed_at IS NULL
         OR delib.kata_signed_at IS NULL
         OR delib.status <> 'approved' THEN
        RAISE EXCEPTION 'daily_session_plan_requires_canonical_deliberation_signatures_before_start'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_unsigned_daily_session_plan_start ON public.did_daily_session_plans;
CREATE TRIGGER guard_unsigned_daily_session_plan_start
BEFORE INSERT OR UPDATE OF status, lifecycle_status, started_at, ready_to_start_at, program_status, urgency_breakdown
ON public.did_daily_session_plans
FOR EACH ROW
EXECUTE FUNCTION public.guard_unsigned_daily_session_plan_start();