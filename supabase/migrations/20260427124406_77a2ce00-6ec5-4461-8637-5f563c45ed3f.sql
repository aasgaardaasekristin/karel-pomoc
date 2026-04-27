ALTER TABLE public.did_daily_session_plans
  ADD COLUMN IF NOT EXISTS program_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS ready_to_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS start_block_reason text,
  ADD COLUMN IF NOT EXISTS drive_sync_status text NOT NULL DEFAULT 'not_queued',
  ADD COLUMN IF NOT EXISTS drive_document_id text,
  ADD COLUMN IF NOT EXISTS drive_document_url text,
  ADD COLUMN IF NOT EXISTS kartoteka_card_target text,
  ADD COLUMN IF NOT EXISTS last_drive_sync_error text,
  ADD COLUMN IF NOT EXISTS last_drive_sync_at timestamptz;

ALTER TABLE public.did_daily_session_plans
  DROP CONSTRAINT IF EXISTS did_daily_session_plans_program_status_check;

ALTER TABLE public.did_daily_session_plans
  ADD CONSTRAINT did_daily_session_plans_program_status_check
  CHECK (program_status IN ('draft','awaiting_therapist_review','in_revision','approved','ready_to_start','in_progress','completed','evaluated','archived','cancelled'));

ALTER TABLE public.did_daily_session_plans
  DROP CONSTRAINT IF EXISTS did_daily_session_plans_drive_sync_status_check;

ALTER TABLE public.did_daily_session_plans
  ADD CONSTRAINT did_daily_session_plans_drive_sync_status_check
  CHECK (drive_sync_status IN ('not_queued','queued','syncing','synced','failed','retrying','skipped'));

CREATE INDEX IF NOT EXISTS idx_did_daily_session_plans_program_status_date
  ON public.did_daily_session_plans(user_id, plan_date DESC, program_status);

CREATE INDEX IF NOT EXISTS idx_did_daily_session_plans_drive_sync
  ON public.did_daily_session_plans(user_id, drive_sync_status, plan_date DESC);

ALTER TABLE public.did_session_reviews
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'session',
  ADD COLUMN IF NOT EXISTS lead_person text,
  ADD COLUMN IF NOT EXISTS assistant_persons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS approved_program_id uuid,
  ADD COLUMN IF NOT EXISTS program_title text,
  ADD COLUMN IF NOT EXISTS main_topic text,
  ADD COLUMN IF NOT EXISTS clinical_findings text,
  ADD COLUMN IF NOT EXISTS implications_for_part text,
  ADD COLUMN IF NOT EXISTS implications_for_whole_system text,
  ADD COLUMN IF NOT EXISTS recommendations_for_therapists text,
  ADD COLUMN IF NOT EXISTS recommendations_for_next_session text,
  ADD COLUMN IF NOT EXISTS recommendations_for_next_playroom text,
  ADD COLUMN IF NOT EXISTS team_closing text,
  ADD COLUMN IF NOT EXISTS detail_analysis_drive_id text,
  ADD COLUMN IF NOT EXISTS detail_analysis_drive_url text,
  ADD COLUMN IF NOT EXISTS practical_report_drive_id text,
  ADD COLUMN IF NOT EXISTS practical_report_drive_url text,
  ADD COLUMN IF NOT EXISTS kartoteka_card_target text,
  ADD COLUMN IF NOT EXISTS synced_to_drive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drive_sync_status text NOT NULL DEFAULT 'not_queued',
  ADD COLUMN IF NOT EXISTS last_sync_error text,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_of_truth_status text NOT NULL DEFAULT 'pending_drive_sync';

ALTER TABLE public.did_session_reviews
  DROP CONSTRAINT IF EXISTS did_session_reviews_mode_check;

ALTER TABLE public.did_session_reviews
  ADD CONSTRAINT did_session_reviews_mode_check
  CHECK (mode IN ('playroom','session'));

ALTER TABLE public.did_session_reviews
  DROP CONSTRAINT IF EXISTS did_session_reviews_drive_sync_status_check;

ALTER TABLE public.did_session_reviews
  ADD CONSTRAINT did_session_reviews_drive_sync_status_check
  CHECK (drive_sync_status IN ('not_queued','queued','syncing','synced','failed','retrying','skipped'));

ALTER TABLE public.did_session_reviews
  DROP CONSTRAINT IF EXISTS did_session_reviews_source_of_truth_status_check;

ALTER TABLE public.did_session_reviews
  ADD CONSTRAINT did_session_reviews_source_of_truth_status_check
  CHECK (source_of_truth_status IN ('pending_drive_sync','drive_synced','drive_failed','kartoteka_synced','partial_sync','skipped'));

CREATE INDEX IF NOT EXISTS idx_did_session_reviews_mode_sync_date
  ON public.did_session_reviews(user_id, mode, drive_sync_status, session_date DESC);

CREATE TABLE IF NOT EXISTS public.karel_runtime_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  runtime_packet_id text NOT NULL DEFAULT gen_random_uuid()::text,
  function_name text NOT NULL DEFAULT 'karel-chat',
  model_used text,
  model_tier text,
  did_sub_mode text,
  prompt_contract_version text,
  has_multimodal_input boolean NOT NULL DEFAULT false,
  has_drive_sync boolean NOT NULL DEFAULT false,
  evaluation_status text NOT NULL DEFAULT 'not_evaluated',
  fallback_reason text,
  request_mode text,
  part_name text,
  thread_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_runtime_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own Karel runtime audit logs" ON public.karel_runtime_audit_logs;
CREATE POLICY "Users can view own Karel runtime audit logs"
ON public.karel_runtime_audit_logs
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own Karel runtime audit logs" ON public.karel_runtime_audit_logs;
CREATE POLICY "Users can create own Karel runtime audit logs"
ON public.karel_runtime_audit_logs
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_karel_runtime_audit_logs_user_created
  ON public.karel_runtime_audit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_karel_runtime_audit_logs_runtime_packet
  ON public.karel_runtime_audit_logs(runtime_packet_id);

CREATE TABLE IF NOT EXISTS public.did_daily_consolidation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  run_date date NOT NULL,
  scheduled_for timestamptz,
  timezone text NOT NULL DEFAULT 'Europe/Prague',
  status text NOT NULL DEFAULT 'started',
  processed_playrooms integer NOT NULL DEFAULT 0,
  processed_sessions integer NOT NULL DEFAULT 0,
  partial_sessions integer NOT NULL DEFAULT 0,
  drive_sync_status text NOT NULL DEFAULT 'not_queued',
  retry_count integer NOT NULL DEFAULT 0,
  error_message text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_daily_consolidation_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.did_daily_consolidation_runs
  DROP CONSTRAINT IF EXISTS did_daily_consolidation_runs_status_check;

ALTER TABLE public.did_daily_consolidation_runs
  ADD CONSTRAINT did_daily_consolidation_runs_status_check
  CHECK (status IN ('started','completed','completed_with_warnings','failed','retrying'));

ALTER TABLE public.did_daily_consolidation_runs
  DROP CONSTRAINT IF EXISTS did_daily_consolidation_runs_drive_sync_status_check;

ALTER TABLE public.did_daily_consolidation_runs
  ADD CONSTRAINT did_daily_consolidation_runs_drive_sync_status_check
  CHECK (drive_sync_status IN ('not_queued','queued','syncing','synced','failed','retrying','skipped'));

DROP POLICY IF EXISTS "Users can view own DID daily consolidation runs" ON public.did_daily_consolidation_runs;
CREATE POLICY "Users can view own DID daily consolidation runs"
ON public.did_daily_consolidation_runs
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own DID daily consolidation runs" ON public.did_daily_consolidation_runs;
CREATE POLICY "Users can create own DID daily consolidation runs"
ON public.did_daily_consolidation_runs
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_did_daily_consolidation_runs_date
  ON public.did_daily_consolidation_runs(run_date DESC, status);

CREATE INDEX IF NOT EXISTS idx_did_daily_consolidation_runs_user_date
  ON public.did_daily_consolidation_runs(user_id, run_date DESC);