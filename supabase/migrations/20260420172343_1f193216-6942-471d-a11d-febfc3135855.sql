-- Working Memory Slice 1: derived operational layer (NOT a source of truth)
CREATE TABLE public.karel_working_memory_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  snapshot_key TEXT NOT NULL,
  snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sync_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique snapshot per (user_id, snapshot_key) → upsert target
CREATE UNIQUE INDEX karel_wm_snapshots_user_key_uidx
  ON public.karel_working_memory_snapshots (user_id, snapshot_key);

-- Fast "latest snapshot" lookup
CREATE INDEX karel_wm_snapshots_user_generated_idx
  ON public.karel_working_memory_snapshots (user_id, generated_at DESC);

-- Enable RLS
ALTER TABLE public.karel_working_memory_snapshots ENABLE ROW LEVEL SECURITY;

-- Authenticated user can read own snapshots
CREATE POLICY "wm_snapshots_select_own"
  ON public.karel_working_memory_snapshots
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Authenticated user can insert own snapshots
CREATE POLICY "wm_snapshots_insert_own"
  ON public.karel_working_memory_snapshots
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Authenticated user can update own snapshots
CREATE POLICY "wm_snapshots_update_own"
  ON public.karel_working_memory_snapshots
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Authenticated user can delete own snapshots
CREATE POLICY "wm_snapshots_delete_own"
  ON public.karel_working_memory_snapshots
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role bypass for cron / edge functions hydration
CREATE POLICY "wm_snapshots_service_all"
  ON public.karel_working_memory_snapshots
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Reuse existing updated_at trigger function pattern
CREATE OR REPLACE FUNCTION public.karel_wm_snapshots_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER karel_wm_snapshots_updated_at
  BEFORE UPDATE ON public.karel_working_memory_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.karel_wm_snapshots_set_updated_at();