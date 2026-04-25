ALTER TABLE public.did_session_reviews
  DROP CONSTRAINT IF EXISTS did_session_reviews_plan_id_fkey;

ALTER TABLE public.did_session_reviews
  ADD CONSTRAINT did_session_reviews_plan_id_fkey
  FOREIGN KEY (plan_id)
  REFERENCES public.did_daily_session_plans(id)
  ON DELETE CASCADE;
