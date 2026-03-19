DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND tablename = 'karel_hana_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.karel_hana_conversations;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND tablename = 'research_threads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.research_threads;
  END IF;
END $$;