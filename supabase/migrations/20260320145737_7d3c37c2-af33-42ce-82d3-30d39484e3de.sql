
ALTER TABLE public.karel_memory_logs 
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.karel_memory_logs 
  ADD COLUMN IF NOT EXISTS job_type text NOT NULL DEFAULT 'mirror';
