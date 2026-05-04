CREATE TABLE IF NOT EXISTS public.did_p25_session_evaluate_fixture_audit (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  before_image jsonb not null,
  expired_at timestamptz not null default now(),
  reason text not null
);
ALTER TABLE public.did_p25_session_evaluate_fixture_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "p25_audit_service_only" ON public.did_p25_session_evaluate_fixture_audit FOR ALL USING (false) WITH CHECK (false);