
DO $$
DECLARE
  r record;
  new_text text;
BEGIN
  FOR r IN
    SELECT id, karel_proposed_plan
    FROM public.did_team_deliberations
    WHERE karel_proposed_plan ILIKE '%fallback%'
  LOOP
    new_text := r.karel_proposed_plan;
    new_text := regexp_replace(new_text, 'Fallbackem je', 'Záložní postup je', 'gi');
    new_text := regexp_replace(new_text, 'Fallbacky\s*:', 'Když to nejde:', 'gi');
    new_text := regexp_replace(new_text, 'Fallback\s*:', 'Když to nejde:', 'gi');
    new_text := regexp_replace(new_text, '\mfallback(em|u|y|ů)?\M', 'záložní postup', 'gi');
    new_text := regexp_replace(new_text, '\mFallback\M', 'záložní postup', 'g');

    IF new_text IS DISTINCT FROM r.karel_proposed_plan THEN
      PERFORM public.did_snapshot_protected_mutation(
        'did_team_deliberations', r.id,
        'P1 cleanup: replace technical Fallback terms in karel_proposed_plan',
        'migration:p1_fallback_cleanup_v2'
      );
      UPDATE public.did_team_deliberations
        SET karel_proposed_plan = new_text,
            updated_at = now()
        WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
