
-- ============================================
-- FÁZE 1: Paměťový systém Karla
-- ============================================

-- 1. EPISODICKÁ PAMĚŤ
CREATE TABLE public.karel_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  timestamp_start timestamptz NOT NULL DEFAULT now(),
  timestamp_end timestamptz,
  domain text NOT NULL DEFAULT 'HANA' CHECK (domain IN ('HANA', 'DID', 'PRACE')),
  participants text[] NOT NULL DEFAULT '{}',
  hana_state text NOT NULL DEFAULT 'EMO_KLIDNA',
  summary_user text NOT NULL DEFAULT '',
  summary_karel text NOT NULL DEFAULT '',
  reasoning_notes text NOT NULL DEFAULT '',
  emotional_intensity integer NOT NULL DEFAULT 3 CHECK (emotional_intensity BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  links_to_other_episodes uuid[] NOT NULL DEFAULT '{}',
  derived_facts text[] NOT NULL DEFAULT '{}',
  actions_taken text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT '',
  source_conversation_id text,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own episodes" ON public.karel_episodes FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own episodes" ON public.karel_episodes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own episodes" ON public.karel_episodes FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own episodes" ON public.karel_episodes FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_karel_episodes_domain ON public.karel_episodes(domain);
CREATE INDEX idx_karel_episodes_timestamp ON public.karel_episodes(timestamp_start DESC);
CREATE INDEX idx_karel_episodes_user ON public.karel_episodes(user_id);
CREATE INDEX idx_karel_episodes_hana_state ON public.karel_episodes(hana_state);
CREATE INDEX idx_karel_episodes_archived ON public.karel_episodes(is_archived);

-- 2. SÉMANTICKÁ PAMĚŤ – Entity (osoby a části)
CREATE TABLE public.karel_semantic_entities (
  id text PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  jmeno text NOT NULL,
  typ text NOT NULL DEFAULT 'clovek' CHECK (typ IN ('clovek', 'cast', 'klient', 'rodina', 'jiny')),
  role_vuci_hance text NOT NULL DEFAULT '',
  stabilni_vlastnosti text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  evidence_episodes uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_semantic_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own entities" ON public.karel_semantic_entities FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own entities" ON public.karel_semantic_entities FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own entities" ON public.karel_semantic_entities FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own entities" ON public.karel_semantic_entities FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3. SÉMANTICKÁ PAMĚŤ – Vztahy
CREATE TABLE public.karel_semantic_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  subject_id text NOT NULL,
  relation text NOT NULL,
  object_id text NOT NULL,
  description text NOT NULL DEFAULT '',
  evidence_episodes uuid[] NOT NULL DEFAULT '{}',
  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_semantic_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own relations" ON public.karel_semantic_relations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own relations" ON public.karel_semantic_relations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own relations" ON public.karel_semantic_relations FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own relations" ON public.karel_semantic_relations FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 4. SÉMANTICKÁ PAMĚŤ – Vzorce chování
CREATE TABLE public.karel_semantic_patterns (
  id text PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  description text NOT NULL,
  evidence_episodes uuid[] NOT NULL DEFAULT '{}',
  confidence numeric NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  domain text NOT NULL DEFAULT 'HANA' CHECK (domain IN ('HANA', 'DID', 'PRACE')),
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_semantic_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own patterns" ON public.karel_semantic_patterns FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own patterns" ON public.karel_semantic_patterns FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own patterns" ON public.karel_semantic_patterns FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own patterns" ON public.karel_semantic_patterns FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 5. PROCEDURÁLNÍ PAMĚŤ – Strategie
CREATE TABLE public.karel_strategies (
  id text PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  domain text NOT NULL DEFAULT 'HANA' CHECK (domain IN ('HANA', 'DID', 'PRACE')),
  hana_state text NOT NULL DEFAULT '',
  required_tags_any text[] NOT NULL DEFAULT '{}',
  description text NOT NULL,
  guidelines text[] NOT NULL DEFAULT '{}',
  example_phrases text[] NOT NULL DEFAULT '{}',
  effectiveness_score numeric NOT NULL DEFAULT 0.5 CHECK (effectiveness_score BETWEEN 0 AND 1),
  evidence_episodes uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own strategies" ON public.karel_strategies FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own strategies" ON public.karel_strategies FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own strategies" ON public.karel_strategies FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own strategies" ON public.karel_strategies FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 6. LOGY PAMĚŤOVÉHO SYSTÉMU
CREATE TABLE public.karel_memory_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  log_type text NOT NULL DEFAULT 'daily_job' CHECK (log_type IN ('daily_job', 'episode_selection', 'consolidation', 'boot', 'manual_refresh')),
  summary text NOT NULL DEFAULT '',
  episodes_created integer NOT NULL DEFAULT 0,
  semantic_updates integer NOT NULL DEFAULT 0,
  strategy_updates integer NOT NULL DEFAULT 0,
  errors text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_memory_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own logs" ON public.karel_memory_logs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own logs" ON public.karel_memory_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- 7. KONVERZACE HANA REŽIMU (persistentní chat historie)
CREATE TABLE public.karel_hana_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  messages jsonb NOT NULL DEFAULT '[]',
  current_domain text NOT NULL DEFAULT 'HANA' CHECK (current_domain IN ('HANA', 'DID', 'PRACE')),
  current_hana_state text NOT NULL DEFAULT 'EMO_KLIDNA',
  is_active boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.karel_hana_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own hana conversations" ON public.karel_hana_conversations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own hana conversations" ON public.karel_hana_conversations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own hana conversations" ON public.karel_hana_conversations FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own hana conversations" ON public.karel_hana_conversations FOR DELETE TO authenticated USING (auth.uid() = user_id);
