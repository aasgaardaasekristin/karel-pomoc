
-- 1. thread_processing_log
CREATE TABLE public.thread_processing_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  part_id text NOT NULL,
  processed_at timestamptz,
  processing_type text NOT NULL DEFAULT 'kartoteka_update',
  status text NOT NULL DEFAULT 'pending',
  notes jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid()
);

ALTER TABLE public.thread_processing_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on thread_processing_log"
  ON public.thread_processing_log FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Auth users can read own thread_processing_log"
  ON public.thread_processing_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Auth users can insert own thread_processing_log"
  ON public.thread_processing_log FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Auth users can update own thread_processing_log"
  ON public.thread_processing_log FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- 2. card_update_queue
CREATE TABLE public.card_update_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id text NOT NULL,
  section text NOT NULL,
  subsection text DEFAULT '',
  action text NOT NULL DEFAULT 'add',
  old_content text DEFAULT '',
  new_content text DEFAULT '',
  reason text DEFAULT '',
  source_thread_id uuid,
  source_date date,
  priority integer NOT NULL DEFAULT 5,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid()
);

ALTER TABLE public.card_update_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on card_update_queue"
  ON public.card_update_queue FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Auth users can read own card_update_queue"
  ON public.card_update_queue FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Auth users can insert own card_update_queue"
  ON public.card_update_queue FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Auth users can update own card_update_queue"
  ON public.card_update_queue FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);
