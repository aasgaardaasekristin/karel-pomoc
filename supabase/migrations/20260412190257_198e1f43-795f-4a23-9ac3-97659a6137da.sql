ALTER TABLE public.crisis_closure_checklist
  ADD COLUMN IF NOT EXISTS grounding_works boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS trigger_managed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_open_questions boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS relapse_plan_exists boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS karel_recommends_closure boolean DEFAULT false;