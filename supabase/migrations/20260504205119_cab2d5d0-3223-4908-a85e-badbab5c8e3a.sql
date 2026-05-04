-- P23 Phase 7: quarantine legacy NULL-user did_daily_briefings rows

CREATE TABLE IF NOT EXISTS public.did_p23_null_user_quarantine_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  before_image jsonb NOT NULL,
  quarantine_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.did_p23_null_user_quarantine_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p23_null_user_audit_no_client_access" ON public.did_p23_null_user_quarantine_audit;
CREATE POLICY "p23_null_user_audit_no_client_access"
  ON public.did_p23_null_user_quarantine_audit
  FOR SELECT
  USING (false);

CREATE INDEX IF NOT EXISTS idx_did_p23_null_user_audit_row
  ON public.did_p23_null_user_quarantine_audit (table_name, row_id);

-- ČÁST C — before-image audit (insert only rows not yet quarantined)
INSERT INTO public.did_p23_null_user_quarantine_audit (
  table_name, row_id, before_image, quarantine_reason
)
SELECT
  'did_daily_briefings',
  b.id,
  to_jsonb(b),
  'P23 legacy NULL-user briefing quarantine: orphan row from pre-canonical scope period'
FROM public.did_daily_briefings b
WHERE b.user_id IS NULL
  AND COALESCE((b.payload->'legacy_null_user_quarantine'->>'active')::boolean, false) IS NOT TRUE;

-- ČÁST D — quarantine marker (no deletion, no retroactive ownership)
UPDATE public.did_daily_briefings
SET
  is_stale = true,
  payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
    'legacy_null_user_quarantine', jsonb_build_object(
      'active', true,
      'reason', 'legacy NULL-user briefing from pre-canonical scope period',
      'canonical_user_id', '8a7816ee-4fd1-43d4-8d83-4230d7517ae1',
      'quarantined_at', now(),
      'p23', true
    )
  )
WHERE user_id IS NULL
  AND COALESCE((payload->'legacy_null_user_quarantine'->>'active')::boolean, false) IS NOT TRUE;