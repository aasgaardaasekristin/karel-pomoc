-- Drop old constraint and add broader one
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'karel_memory_logs'
      AND con.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.karel_memory_logs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- No CHECK constraint - allow any log_type value for flexibility

-- Add UPDATE RLS policy
CREATE POLICY "Users can update own logs"
ON public.karel_memory_logs
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add DELETE RLS policy  
CREATE POLICY "Users can delete own logs"
ON public.karel_memory_logs
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);