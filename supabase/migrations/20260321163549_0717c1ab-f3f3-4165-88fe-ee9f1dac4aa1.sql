ALTER TABLE public.did_therapist_tasks 
ADD COLUMN IF NOT EXISTS task_tier text NOT NULL DEFAULT 'operative' 
CHECK (task_tier IN ('operative', 'tactical', 'strategic'));