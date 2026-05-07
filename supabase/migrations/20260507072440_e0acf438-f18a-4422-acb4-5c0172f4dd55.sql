
CREATE TABLE IF NOT EXISTS public.hana_personal_response_guard_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  thread_id TEXT,
  identity_audit_id UUID,
  input_hash TEXT,
  response_hash TEXT,
  resolution_kind TEXT,
  speaker_identity TEXT,
  response_guard_status TEXT NOT NULL,
  blocked_reason TEXT,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  used_fallback BOOLEAN NOT NULL DEFAULT false,
  marker TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.hana_personal_response_guard_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_response_guard_audit"
ON public.hana_personal_response_guard_audit
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "users_read_own_response_guard_audit"
ON public.hana_personal_response_guard_audit
FOR SELECT
USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_hana_response_guard_audit_user_created
ON public.hana_personal_response_guard_audit (user_id, created_at DESC);
