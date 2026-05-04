
-- P18: legacy wrong-user scope quarantine — audit table only.
-- Stores complete before-image of every quarantined row so we can reverse
-- without "blind delete". Quarantine markers go into existing jsonb/text
-- columns of source tables (no new architecture, no schema changes there).
CREATE TABLE IF NOT EXISTS public.did_p18_quarantine_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  wrong_user_id uuid NOT NULL,
  canonical_user_id uuid NOT NULL,
  before_image jsonb NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL DEFAULT 'p18_legacy_wrong_user_scope_quarantine',
  quarantined_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_p18_quarantine_audit ENABLE ROW LEVEL SECURITY;

-- Service role only (no client access; this is internal audit).
CREATE POLICY "p18_audit_service_role_only_select"
  ON public.did_p18_quarantine_audit FOR SELECT
  USING (false);
CREATE POLICY "p18_audit_service_role_only_insert"
  ON public.did_p18_quarantine_audit FOR INSERT
  WITH CHECK (false);

CREATE INDEX IF NOT EXISTS idx_did_p18_quarantine_audit_table_row
  ON public.did_p18_quarantine_audit(table_name, row_id);
