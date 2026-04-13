ALTER TABLE public.did_part_registry 
  ADD COLUMN IF NOT EXISTS index_confirmed_at timestamptz;