
-- P32 hana_personal_identity_audit
CREATE TABLE IF NOT EXISTS public.hana_personal_identity_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  thread_id text,
  message_ref text,
  surface text NOT NULL DEFAULT 'hana_personal',
  input_hash text NOT NULL,
  resolution_kind text NOT NULL,
  speaker_identity text NOT NULL,
  mentioned_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  mentioned_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  should_create_hana_memory boolean,
  should_create_part_observation boolean,
  should_create_part_card_update boolean,
  memory_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  marker text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hana_personal_identity_audit_user_created_idx
  ON public.hana_personal_identity_audit (user_id, created_at DESC);

ALTER TABLE public.hana_personal_identity_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their identity audit"
  ON public.hana_personal_identity_audit;
CREATE POLICY "Users can read their identity audit"
  ON public.hana_personal_identity_audit
  FOR SELECT
  USING (auth.uid() = user_id);

-- Quarantine wrongly-registered Hana therapist aliases as DID parts
UPDATE public.did_part_registry
SET status = 'quarantined_wrong_identity_p32',
    notes = COALESCE(notes, '') ||
            E'\n[P32] Quarantined: this row is a Hana therapist alias, not a DID part. Resolver excludes it.',
    updated_at = now()
WHERE lower(part_name) IN ('hana','hanka','hani','hanička','hanicka','haničko','hanko','mamka','mama','maminka')
  AND status NOT LIKE 'quarantined%';
