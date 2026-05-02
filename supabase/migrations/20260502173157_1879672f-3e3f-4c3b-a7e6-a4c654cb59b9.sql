
ALTER TABLE public.did_daily_session_plans DISABLE TRIGGER USER;
INSERT INTO public.did_daily_session_plans (
  id, user_id, plan_date, selected_part, urgency_score, urgency_breakdown,
  plan_markdown, therapist, status, lifecycle_status, program_status,
  generated_by, session_lead, session_format, started_at, started_by,
  approved_at, ready_to_start_at, start_source
) VALUES (
  '11111111-2222-3333-4444-555555555555',
  '8a7816ee-4fd1-43d4-8d83-4230d7517ae1',
  CURRENT_DATE,
  'Tundrupek',
  0,
  jsonb_build_object(
    'test_acceptance_fixture', true,
    'source', 'P1_visible_text_guard_live_dom_proof',
    'approval_sync', jsonb_build_object('status','synced','source','fixture')
  ),
  E'# Plán dnešní herny s Tundrupek\n\n## Program sezení\n\n1. **Bezpečný práh** (3 min)\n   Karel nabídne volbu odpovědět slovem, symbolem nebo tichem.\n\n2. **Jaké je dnes uvnitř počasí** (5 min)\n   Karel nechá Tundrupka popsat dnešní stav jedním obrazem.\n\n3. **Měkké ukončení** (3 min)\n   Karel shrne jen to, co bylo řečeno.\n',
  'hanka',
  'in_progress',
  'in_progress',
  'in_progress',
  'fixture',
  'hanka',
  'osobně',
  now(),
  '8a7816ee-4fd1-43d4-8d83-4230d7517ae1',
  now(),
  now(),
  'P1_visible_text_guard_live_dom_proof'
);
ALTER TABLE public.did_daily_session_plans ENABLE TRIGGER USER;
