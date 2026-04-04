ALTER TABLE public.did_part_registry
ADD COLUMN IF NOT EXISTS manual_state_override text;