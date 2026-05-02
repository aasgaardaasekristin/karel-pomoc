
ALTER TABLE public.did_daily_session_plans DISABLE TRIGGER USER;
DELETE FROM public.did_daily_session_plans WHERE id='11111111-2222-3333-4444-555555555555';
ALTER TABLE public.did_daily_session_plans ENABLE TRIGGER USER;
