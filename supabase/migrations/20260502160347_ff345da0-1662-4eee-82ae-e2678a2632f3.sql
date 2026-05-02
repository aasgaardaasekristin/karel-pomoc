-- P1 visible-text cleanup with snapshots
DO $$
DECLARE
  r record;
BEGIN
  -- did_team_deliberations: snapshot then sanitize visible Karel-generated text fields
  FOR r IN
    SELECT id FROM public.did_team_deliberations
    WHERE
      COALESCE(initial_karel_brief,'') ~* 'Karel-led|Fallback:'
      OR COALESCE(karel_synthesis::text,'') ~* 'Karel-led'
      OR COALESCE(karel_proposed_plan::text,'') ~* 'Karel-led'
      OR COALESCE(final_summary,'') ~* 'Karel-led'
      OR COALESCE(program_draft::text,'') ~* 'Karel-led'
  LOOP
    PERFORM public.did_snapshot_protected_mutation(
      'did_team_deliberations', r.id,
      'P1 visible-text cleanup: replace Karel-led / Fallback: in visible Karel-generated fields',
      'migration:p1_persisted_violation_cleanup'
    );
    UPDATE public.did_team_deliberations
       SET initial_karel_brief = REGEXP_REPLACE(COALESCE(initial_karel_brief,''), 'Karel-led', 'vede Karel', 'gi'),
           final_summary       = REGEXP_REPLACE(COALESCE(final_summary,''),       'Karel-led', 'vede Karel', 'gi'),
           updated_at = now()
     WHERE id = r.id;
  END LOOP;

  -- did_daily_session_plans: snapshot then sanitize plan_markdown
  FOR r IN
    SELECT id FROM public.did_daily_session_plans
    WHERE plan_markdown ~* 'Karel-led|(^|\n)\s*Fallback:|\*\*Fallback\*\*'
  LOOP
    PERFORM public.did_snapshot_protected_mutation(
      'did_daily_session_plans', r.id,
      'P1 visible-text cleanup: replace Karel-led and Fallback: label in plan_markdown',
      'migration:p1_persisted_violation_cleanup'
    );
    UPDATE public.did_daily_session_plans
       SET plan_markdown = REGEXP_REPLACE(
                             REGEXP_REPLACE(
                               REGEXP_REPLACE(COALESCE(plan_markdown,''), 'Karel-led', 'vede Karel', 'gi'),
                               '\*\*Fallback\*\*', '**Když to nejde**', 'gi'
                             ),
                             '(^|\n)(\s*)Fallback:', '\1\2Když to nejde:', 'gi'
                           ),
           updated_at = now()
     WHERE id = r.id;
  END LOOP;
END $$;

-- Audit verification
DO $$
DECLARE
  v_team int;
  v_plan int;
BEGIN
  SELECT COUNT(*) INTO v_team FROM public.did_team_deliberations
   WHERE COALESCE(initial_karel_brief,'') ~* 'Karel-led'
      OR COALESCE(final_summary,'') ~* 'Karel-led';
  SELECT COUNT(*) INTO v_plan FROM public.did_daily_session_plans
   WHERE plan_markdown ~* 'Karel-led|(^|\n)\s*Fallback:|\*\*Fallback\*\*';
  IF v_team > 0 OR v_plan > 0 THEN
    RAISE EXCEPTION 'P1 cleanup verification failed: team=% plan=%', v_team, v_plan;
  END IF;
END $$;