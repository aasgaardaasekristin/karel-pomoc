
CREATE TABLE IF NOT EXISTS public.hana_personal_external_trigger_lookups (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  source_thread_id uuid,
  source_message_ref text,
  source_ref text NOT NULL,
  related_part_name text,
  related_groups text[] NOT NULL DEFAULT ARRAY[]::text[],
  theme text NOT NULL,
  query_terms text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending',
  lookup_result jsonb,
  used_in_briefing boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_ref, theme)
);
CREATE INDEX IF NOT EXISTS idx_hana_ext_trigger_user ON public.hana_personal_external_trigger_lookups(user_id);
CREATE INDEX IF NOT EXISTS idx_hana_ext_trigger_status ON public.hana_personal_external_trigger_lookups(status);

ALTER TABLE public.hana_personal_external_trigger_lookups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "canonical_user_can_read_hana_ext_trigger" ON public.hana_personal_external_trigger_lookups;
CREATE POLICY "canonical_user_can_read_hana_ext_trigger"
  ON public.hana_personal_external_trigger_lookups FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
DROP POLICY IF EXISTS "service_role_writes_hana_ext_trigger" ON public.hana_personal_external_trigger_lookups;
CREATE POLICY "service_role_writes_hana_ext_trigger"
  ON public.hana_personal_external_trigger_lookups FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS public.hana_personal_privacy_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  source_thread_id uuid,
  source_ref text NOT NULL,
  instruction_text text NOT NULL,
  applies_to_scope text NOT NULL DEFAULT 'never_child_visible',
  related_parts text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_hana_privacy_active ON public.hana_personal_privacy_rules(user_id, active);

ALTER TABLE public.hana_personal_privacy_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "canonical_user_can_read_hana_privacy" ON public.hana_personal_privacy_rules;
CREATE POLICY "canonical_user_can_read_hana_privacy"
  ON public.hana_personal_privacy_rules FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
DROP POLICY IF EXISTS "service_role_writes_hana_privacy" ON public.hana_personal_privacy_rules;
CREATE POLICY "service_role_writes_hana_privacy"
  ON public.hana_personal_privacy_rules FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS public.hana_personal_centrum_review_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  source_thread_id uuid,
  source_ref text NOT NULL,
  related_part_name text,
  related_groups text[] NOT NULL DEFAULT ARRAY[]::text[],
  reason text NOT NULL,
  safe_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  used_in_briefing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_ref, related_part_name)
);
CREATE INDEX IF NOT EXISTS idx_hana_centrum_review_status
  ON public.hana_personal_centrum_review_queue(user_id, status);

ALTER TABLE public.hana_personal_centrum_review_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "canonical_user_can_read_hana_centrum_review" ON public.hana_personal_centrum_review_queue;
CREATE POLICY "canonical_user_can_read_hana_centrum_review"
  ON public.hana_personal_centrum_review_queue FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
DROP POLICY IF EXISTS "service_role_writes_hana_centrum_review" ON public.hana_personal_centrum_review_queue;
CREATE POLICY "service_role_writes_hana_centrum_review"
  ON public.hana_personal_centrum_review_queue FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
