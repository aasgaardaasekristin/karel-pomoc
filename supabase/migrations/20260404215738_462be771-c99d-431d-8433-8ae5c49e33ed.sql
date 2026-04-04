
ALTER TABLE public.part_goals ADD COLUMN IF NOT EXISTS goal_type TEXT;
ALTER TABLE public.part_goals ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE public.part_goals ADD COLUMN IF NOT EXISTS state_at_creation TEXT;
