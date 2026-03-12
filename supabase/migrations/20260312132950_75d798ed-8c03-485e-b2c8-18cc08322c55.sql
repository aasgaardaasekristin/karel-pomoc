
ALTER TABLE public.did_therapist_tasks 
  ADD COLUMN IF NOT EXISTS status_hanka text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS status_kata text NOT NULL DEFAULT 'not_started';
