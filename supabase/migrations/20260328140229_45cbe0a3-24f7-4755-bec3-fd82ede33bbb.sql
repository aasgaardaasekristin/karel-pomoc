
-- ═══════════════════════════════════════════════════════
-- FÁZE 1: DATOVÝ MODEL – 6 TABULEK + INDEXY + RLS
-- ═══════════════════════════════════════════════════════

-- 1. did_observations
CREATE TABLE public.did_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('part', 'therapist', 'system', 'context', 'crisis', 'logistics')),
  subject_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('thread', 'task_feedback', 'session', 'switch', 'pulse_check', 'board_note', 'meeting', 'drive_doc', 'web_research', 'therapist_message', 'part_direct')),
  source_ref TEXT,
  fact TEXT NOT NULL,
  evidence_level TEXT NOT NULL DEFAULT 'I1' CHECK (evidence_level IN ('D1', 'D2', 'D3', 'I1', 'H1')),
  confidence NUMERIC(3,2) DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  time_horizon TEXT NOT NULL DEFAULT '0_14d' CHECK (time_horizon IN ('hours', '0_14d', '15_60d', 'long_term')),
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_obs_subject ON public.did_observations(subject_type, subject_id);
CREATE INDEX idx_obs_unprocessed ON public.did_observations(processed) WHERE NOT processed;
CREATE INDEX idx_obs_created ON public.did_observations(created_at DESC);

ALTER TABLE public.did_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select observations" ON public.did_observations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert observations" ON public.did_observations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update observations" ON public.did_observations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access observations" ON public.did_observations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. did_implications
CREATE TABLE public.did_implications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observation_id UUID NOT NULL REFERENCES public.did_observations(id),
  impact_type TEXT NOT NULL CHECK (impact_type IN ('context_only', 'immediate_plan', 'part_profile', 'risk', 'team_coordination')),
  destinations TEXT[] NOT NULL DEFAULT '{}',
  implication_text TEXT NOT NULL,
  owner TEXT DEFAULT 'karel',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'done', 'expired', 'superseded')),
  review_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  synced BOOLEAN DEFAULT false,
  synced_at TIMESTAMPTZ
);

CREATE INDEX idx_impl_obs ON public.did_implications(observation_id);
CREATE INDEX idx_impl_unsynced ON public.did_implications(synced) WHERE NOT synced;
CREATE INDEX idx_impl_status ON public.did_implications(status) WHERE status = 'active';
CREATE INDEX idx_impl_review ON public.did_implications(review_at) WHERE review_at IS NOT NULL;

ALTER TABLE public.did_implications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select implications" ON public.did_implications FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert implications" ON public.did_implications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update implications" ON public.did_implications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access implications" ON public.did_implications FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. did_profile_claims
CREATE TABLE public.did_profile_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  part_name TEXT NOT NULL,
  card_section TEXT NOT NULL CHECK (card_section IN ('A','B','C','D','E','F','G','H','I','J','K','L','M')),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('stable_trait', 'current_state', 'trigger', 'preference', 'relationship', 'risk', 'therapeutic_response', 'hypothesis', 'goal')),
  claim_text TEXT NOT NULL,
  evidence_level TEXT NOT NULL DEFAULT 'I1',
  confidence NUMERIC(3,2) DEFAULT 0.5,
  last_confirmed_at TIMESTAMPTZ DEFAULT now(),
  confirmation_count INT DEFAULT 1,
  source_observation_ids UUID[] DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'needs_revalidation', 'superseded', 'retracted')),
  superseded_by UUID REFERENCES public.did_profile_claims(id)
);

CREATE INDEX idx_claims_part ON public.did_profile_claims(part_name, card_section);
CREATE INDEX idx_claims_active ON public.did_profile_claims(status) WHERE status = 'active';

ALTER TABLE public.did_profile_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select claims" ON public.did_profile_claims FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert claims" ON public.did_profile_claims FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update claims" ON public.did_profile_claims FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access claims" ON public.did_profile_claims FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. did_plan_items
CREATE TABLE public.did_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan_type TEXT NOT NULL CHECK (plan_type IN ('05A', '05B')),
  section TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  content TEXT NOT NULL,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  action_required TEXT,
  assigned_to TEXT,
  due_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'done', 'expired', 'promoted', 'demoted')),
  review_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  source_implication_id UUID REFERENCES public.did_implications(id),
  source_observation_ids UUID[] DEFAULT '{}',
  activation_conditions TEXT,
  promotion_criteria TEXT
);

CREATE INDEX idx_plan_type ON public.did_plan_items(plan_type, section);
CREATE INDEX idx_plan_active ON public.did_plan_items(status) WHERE status = 'active';
CREATE INDEX idx_plan_review ON public.did_plan_items(review_at);
CREATE INDEX idx_plan_subject ON public.did_plan_items(subject_id);

ALTER TABLE public.did_plan_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select plan_items" ON public.did_plan_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert plan_items" ON public.did_plan_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update plan_items" ON public.did_plan_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access plan_items" ON public.did_plan_items FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. did_doc_sync_log
CREATE TABLE public.did_doc_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_document TEXT NOT NULL,
  content_written TEXT NOT NULL,
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

CREATE INDEX idx_sync_target ON public.did_doc_sync_log(target_document, created_at DESC);

ALTER TABLE public.did_doc_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select sync_log" ON public.did_doc_sync_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert sync_log" ON public.did_doc_sync_log FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role full access sync_log" ON public.did_doc_sync_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. did_pending_questions
CREATE TABLE public.did_pending_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  question TEXT NOT NULL,
  context TEXT,
  subject_type TEXT,
  subject_id TEXT,
  directed_to TEXT,
  blocking TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired', 'irrelevant')),
  answer TEXT,
  answered_at TIMESTAMPTZ,
  answered_by TEXT,
  answer_destinations TEXT[] DEFAULT '{}',
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_questions_open ON public.did_pending_questions(status) WHERE status = 'open';

ALTER TABLE public.did_pending_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can select questions" ON public.did_pending_questions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert questions" ON public.did_pending_questions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update questions" ON public.did_pending_questions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access questions" ON public.did_pending_questions FOR ALL TO service_role USING (true) WITH CHECK (true);
