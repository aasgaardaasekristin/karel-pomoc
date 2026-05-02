
ALTER TABLE public.did_daily_session_plans DISABLE TRIGGER USER;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM public.did_daily_session_plans
    WHERE plan_markdown ~* '(Fallback|Karel-led)'
  LOOP
    PERFORM public.did_snapshot_protected_mutation(
      'did_daily_session_plans', r.id,
      'P1_visible_text_cleanup: rewrite Fallback/Karel-led labels in plan_markdown',
      'migration:p1_visible_dom_finish'
    );
    UPDATE public.did_daily_session_plans
       SET plan_markdown = regexp_replace(
             regexp_replace(plan_markdown, '\*\*Fallback:\*\*', '**Když to nejde:**', 'gi'),
             'Karel-led', 'vede Karel', 'gi'
           ),
           updated_at = now()
     WHERE id = r.id;
  END LOOP;
END$$;
ALTER TABLE public.did_daily_session_plans ENABLE TRIGGER USER;
