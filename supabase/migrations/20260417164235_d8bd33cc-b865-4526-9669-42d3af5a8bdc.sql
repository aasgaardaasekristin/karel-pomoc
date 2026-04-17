-- Phase 2: Evidence quality metadata for DB readers
-- Adds freshness/confidence/change_type/needs_verification to did_observations
-- so daily diff and dashboard can filter without parsing Drive content.

ALTER TABLE public.did_observations
  ADD COLUMN IF NOT EXISTS freshness_band text
    CHECK (freshness_band IN ('immediate','recent','historical','timeless')),
  ADD COLUMN IF NOT EXISTS confidence_band text
    CHECK (confidence_band IN ('low','medium','high')),
  ADD COLUMN IF NOT EXISTS change_type text
    CHECK (change_type IN ('new','update','repeat','conflict')),
  ADD COLUMN IF NOT EXISTS needs_verification boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_kind text
    CHECK (evidence_kind IN ('FACT','INFERENCE','PLAN','UNKNOWN'));

CREATE INDEX IF NOT EXISTS idx_did_observations_freshness
  ON public.did_observations (freshness_band, created_at DESC)
  WHERE freshness_band IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_did_observations_change_type
  ON public.did_observations (change_type, created_at DESC)
  WHERE change_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_did_observations_needs_verification
  ON public.did_observations (needs_verification, created_at DESC)
  WHERE needs_verification = true;
