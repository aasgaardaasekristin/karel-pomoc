CREATE TABLE public.card_update_processed_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  thread_id text NOT NULL,
  last_processed_message_id text,
  last_processed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(part_name, thread_id)
);
ALTER TABLE public.card_update_processed_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can select processed_threads" ON public.card_update_processed_threads FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access processed_threads" ON public.card_update_processed_threads FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.card_update_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name text NOT NULL,
  sections_updated text[] DEFAULT '{}',
  sections_skipped text[] DEFAULT '{}',
  web_searches_performed int DEFAULT 0,
  new_therapy_methods_added int DEFAULT 0,
  contradictions_found int DEFAULT 0,
  profile_updated boolean DEFAULT false,
  cross_writes text[] DEFAULT '{}',
  processing_time_ms int,
  error text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.card_update_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can select update_log" ON public.card_update_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access update_log" ON public.card_update_log FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.card_crosswrite_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_part text NOT NULL,
  target_file text NOT NULL,
  action text NOT NULL,
  content text NOT NULL,
  status text DEFAULT 'pending',
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.card_crosswrite_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can select crosswrite_queue" ON public.card_crosswrite_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access crosswrite_queue" ON public.card_crosswrite_queue FOR ALL TO service_role USING (true) WITH CHECK (true);