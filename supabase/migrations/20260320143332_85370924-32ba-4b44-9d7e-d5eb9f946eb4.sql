ALTER TABLE public.karel_memory_logs 
ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();