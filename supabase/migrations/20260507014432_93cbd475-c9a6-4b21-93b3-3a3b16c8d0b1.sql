-- P30.1 — Active-part daily situational brief table
CREATE TABLE IF NOT EXISTS public.did_active_part_daily_brief (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  brief_date date NOT NULL,
  part_name text NOT NULL,
  part_id text NULL,
  activity_status text NOT NULL,
  anamnesis_excerpt jsonb NOT NULL DEFAULT '{}'::jsonb,
  known_sensitive_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  anniversaries_today jsonb NOT NULL DEFAULT '[]'::jsonb,
  internet_triggers_today jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_events_today jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_prevention jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by text NOT NULL DEFAULT 'external_reality_watch',
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT did_active_part_daily_brief_status_check CHECK (status IN ('active','expired','superseded')),
  CONSTRAINT did_active_part_daily_brief_activity_check CHECK (activity_status IN ('active_thread','recent_thread','registry_active','watchlist'))
);

CREATE UNIQUE INDEX IF NOT EXISTS did_active_part_daily_brief_unique
  ON public.did_active_part_daily_brief (user_id, brief_date, part_name);
CREATE INDEX IF NOT EXISTS did_active_part_daily_brief_user_date_idx
  ON public.did_active_part_daily_brief (user_id, brief_date);
CREATE INDEX IF NOT EXISTS did_active_part_daily_brief_part_idx
  ON public.did_active_part_daily_brief (part_name);
CREATE INDEX IF NOT EXISTS did_active_part_daily_brief_status_idx
  ON public.did_active_part_daily_brief (status);
CREATE INDEX IF NOT EXISTS did_active_part_daily_brief_expires_idx
  ON public.did_active_part_daily_brief (expires_at);

ALTER TABLE public.did_active_part_daily_brief ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_writes_active_part_brief" ON public.did_active_part_daily_brief;
CREATE POLICY "service_role_writes_active_part_brief"
  ON public.did_active_part_daily_brief
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "canonical_user_reads_active_part_brief" ON public.did_active_part_daily_brief;
CREATE POLICY "canonical_user_reads_active_part_brief"
  ON public.did_active_part_daily_brief
  FOR SELECT
  TO public
  USING (auth.uid() = get_canonical_did_user_id() AND user_id = get_canonical_did_user_id());

CREATE TRIGGER trg_did_active_part_daily_brief_updated_at
  BEFORE UPDATE ON public.did_active_part_daily_brief
  FOR EACH ROW EXECUTE FUNCTION tdelib_set_updated_at();

-- P30.1 — relax internet_watch_status constraint to allow source-truth states
ALTER TABLE public.external_event_watch_runs
  DROP CONSTRAINT IF EXISTS external_event_watch_runs_internet_watch_status_check;
ALTER TABLE public.external_event_watch_runs
  ADD CONSTRAINT external_event_watch_runs_internet_watch_status_check
  CHECK (internet_watch_status IN (
    'implemented',
    'partial',
    'not_implemented',
    'configured',
    'provider_not_configured',
    'provider_error'
  ));