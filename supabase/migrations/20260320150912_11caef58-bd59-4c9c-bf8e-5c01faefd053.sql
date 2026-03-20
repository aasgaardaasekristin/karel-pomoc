ALTER TABLE public.karel_memory_logs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.karel_memory_logs
  ADD COLUMN IF NOT EXISTS job_type text DEFAULT 'mirror';

UPDATE public.karel_memory_logs
SET updated_at = COALESCE(updated_at, now()),
    job_type = COALESCE(job_type, 'mirror')
WHERE updated_at IS NULL OR job_type IS NULL;

ALTER TABLE public.karel_memory_logs
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN job_type SET DEFAULT 'mirror',
  ALTER COLUMN job_type SET NOT NULL;

ALTER TABLE public.karel_memory_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'karel_memory_logs'
      AND policyname = 'Users can update own logs'
  ) THEN
    CREATE POLICY "Users can update own logs"
      ON public.karel_memory_logs
      FOR UPDATE
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'karel_memory_logs'
      AND policyname = 'Users can delete own logs'
  ) THEN
    CREATE POLICY "Users can delete own logs"
      ON public.karel_memory_logs
      FOR DELETE
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END
$$;