-- ============================================================
-- P30.3 — External Reality Watch schema
-- ============================================================

-- 1) Anchor fact cache (source-backed biographical facts)
CREATE TABLE IF NOT EXISTS public.part_external_anchor_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  part_name text NOT NULL,
  anchor_label text NOT NULL,
  anchor_type text NOT NULL,
  canonical_entity_name text,
  fact_type text NOT NULL,
  fact_value text NOT NULL,
  fact_date date,
  source_url text NOT NULL,
  source_title text,
  source_domain text,
  verification_status text NOT NULL DEFAULT 'source_backed_unverified',
  confidence numeric DEFAULT 0.5,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  card_backfill_status text NOT NULL DEFAULT 'not_backfilled',
  card_backfill_write_id uuid,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_part_external_anchor_facts_unique
  ON public.part_external_anchor_facts (
    user_id, part_name, anchor_label, fact_type,
    COALESCE(fact_date, '1900-01-01'::date), source_url
  );

CREATE INDEX IF NOT EXISTS idx_part_external_anchor_facts_part
  ON public.part_external_anchor_facts (user_id, part_name);

ALTER TABLE public.part_external_anchor_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anchor_facts_owner_select" ON public.part_external_anchor_facts;
CREATE POLICY "anchor_facts_owner_select"
  ON public.part_external_anchor_facts
  FOR SELECT
  USING (auth.uid() = user_id);

-- service role bypasses RLS automatically; no insert/update/delete policy for anon.

-- 2) Weekly per-part trigger matrix
CREATE TABLE IF NOT EXISTS public.part_external_reality_weekly_matrix (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  date_prague date NOT NULL,
  part_name text NOT NULL,
  part_relevance_source text NOT NULL,
  part_relevance_reason text,
  card_read_status text NOT NULL,
  personal_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  biographical_anchors jsonb NOT NULL DEFAULT '[]'::jsonb,
  anchor_date_risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  query_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  ignored_example_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_guards jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_status text NOT NULL DEFAULT 'not_run',
  events_count int NOT NULL DEFAULT 0,
  source_backed_events_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, date_prague, part_name)
);

CREATE INDEX IF NOT EXISTS idx_weekly_matrix_user_week
  ON public.part_external_reality_weekly_matrix (user_id, week_start, week_end);

CREATE INDEX IF NOT EXISTS idx_weekly_matrix_user_date
  ON public.part_external_reality_weekly_matrix (user_id, date_prague);

ALTER TABLE public.part_external_reality_weekly_matrix ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weekly_matrix_owner_select" ON public.part_external_reality_weekly_matrix;
CREATE POLICY "weekly_matrix_owner_select"
  ON public.part_external_reality_weekly_matrix
  FOR SELECT
  USING (auth.uid() = user_id);

-- 3) Extend sensitivities to distinguish review-flagged query terms
ALTER TABLE public.part_external_event_sensitivities
  ADD COLUMN IF NOT EXISTS query_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS negative_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS example_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS query_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS example_terms_query_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS query_policy text NOT NULL DEFAULT 'category_template';

-- 4) updated_at triggers
CREATE OR REPLACE FUNCTION public.p30_3_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_anchor_facts_set_updated_at ON public.part_external_anchor_facts;
CREATE TRIGGER trg_anchor_facts_set_updated_at
  BEFORE UPDATE ON public.part_external_anchor_facts
  FOR EACH ROW EXECUTE FUNCTION public.p30_3_set_updated_at();

DROP TRIGGER IF EXISTS trg_weekly_matrix_set_updated_at ON public.part_external_reality_weekly_matrix;
CREATE TRIGGER trg_weekly_matrix_set_updated_at
  BEFORE UPDATE ON public.part_external_reality_weekly_matrix
  FOR EACH ROW EXECUTE FUNCTION public.p30_3_set_updated_at();