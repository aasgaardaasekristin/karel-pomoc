-- P27 F1/J1: persistent Hana personal memory + next opening hint
CREATE TABLE IF NOT EXISTS public.hana_personal_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_thread_id uuid NOT NULL,
  source_message_refs text[] NOT NULL DEFAULT '{}',
  memory_type text NOT NULL,
  emotional_state text,
  safe_summary text NOT NULL,
  next_opening_hint text,
  do_not_export_raw_text boolean NOT NULL DEFAULT true,
  did_relevant boolean NOT NULL DEFAULT false,
  private_to_hana boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hana_personal_memory_user_active
  ON public.hana_personal_memory (user_id, memory_type, created_at DESC)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_hana_personal_memory_thread
  ON public.hana_personal_memory (source_thread_id);

ALTER TABLE public.hana_personal_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own hana_personal_memory"
  ON public.hana_personal_memory FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Service role full hana_personal_memory"
  ON public.hana_personal_memory FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- P27 E1: ensure card_update_queue can carry status/payload safely - add columns if missing
ALTER TABLE public.card_update_queue
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending_therapist_confirmation',
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_card_update_queue_status
  ON public.card_update_queue (user_id, status, created_at DESC);
