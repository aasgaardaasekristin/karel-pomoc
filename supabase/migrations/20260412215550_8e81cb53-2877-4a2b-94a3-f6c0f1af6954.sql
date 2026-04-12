
-- ============================================
-- FÁZE 1: Krizový baseline — DB migrace
-- ============================================

-- 1. therapist_crisis_profile
CREATE TABLE public.therapist_crisis_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_name text NOT NULL UNIQUE,
  aggregate_response_speed_score numeric(3,1) DEFAULT 0,
  aggregate_task_reliability_score numeric(3,1) DEFAULT 0,
  aggregate_observation_quality_score numeric(3,1) DEFAULT 0,
  aggregate_initiative_score numeric(3,1) DEFAULT 0,
  aggregate_meeting_participation_score numeric(3,1) DEFAULT 0,
  aggregate_closure_alignment_score numeric(3,1) DEFAULT 0,
  aggregate_supervision_trust_score numeric(3,1) DEFAULT 0,
  aggregate_crisis_judgment_score numeric(3,1) DEFAULT 0,
  aggregate_escalation_sensitivity_score numeric(3,1) DEFAULT 0,
  aggregate_consistency_score numeric(3,1) DEFAULT 0,
  total_crisis_cases integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.therapist_crisis_profile ENABLE ROW LEVEL SECURITY;

-- 2. therapist_crisis_case_reviews
CREATE TABLE public.therapist_crisis_case_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_event_id uuid NOT NULL REFERENCES public.crisis_events(id) ON DELETE CASCADE,
  therapist_name text NOT NULL,
  response_speed_score numeric(3,1),
  task_reliability_score numeric(3,1),
  observation_quality_score numeric(3,1),
  initiative_score numeric(3,1),
  meeting_participation_score numeric(3,1),
  closure_alignment_score numeric(3,1),
  supervision_trust_score numeric(3,1),
  crisis_judgment_score numeric(3,1),
  escalation_sensitivity_score numeric(3,1),
  consistency_score numeric(3,1),
  supervision_notes text,
  strengths_observed text[],
  risks_observed text[],
  recommended_karel_mode text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.therapist_crisis_case_reviews ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_case_reviews_crisis_event ON public.therapist_crisis_case_reviews(crisis_event_id);
CREATE INDEX idx_case_reviews_therapist ON public.therapist_crisis_case_reviews(therapist_name);

-- 3. crisis_karel_interviews
CREATE TABLE public.crisis_karel_interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_event_id uuid NOT NULL REFERENCES public.crisis_events(id) ON DELETE CASCADE,
  part_name text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  interview_type text NOT NULL DEFAULT 'diagnostic',
  interview_goal text,
  hidden_diagnostic_hypotheses jsonb DEFAULT '[]'::jsonb,
  stabilization_methods_used text[],
  observed_regulation numeric(3,1),
  observed_trust numeric(3,1),
  observed_coherence numeric(3,1),
  observed_somatic_state text,
  observed_risk_signals text[],
  what_shifted text,
  what_remains_unclear text,
  karel_decision_after_interview text,
  next_required_actions jsonb DEFAULT '[]'::jsonb,
  summary_for_team text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crisis_karel_interviews ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_karel_interviews_crisis_event ON public.crisis_karel_interviews(crisis_event_id);
CREATE INDEX idx_karel_interviews_part ON public.crisis_karel_interviews(part_name);

-- 4. crisis_session_questions
CREATE TABLE public.crisis_session_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crisis_event_id uuid NOT NULL REFERENCES public.crisis_events(id) ON DELETE CASCADE,
  session_plan_id uuid REFERENCES public.did_daily_session_plans(id) ON DELETE SET NULL,
  therapist_name text NOT NULL,
  question_text text NOT NULL,
  required_by timestamptz,
  answered_at timestamptz,
  answer_text text,
  answer_quality_score numeric(3,1),
  karel_analysis text,
  karel_analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crisis_session_questions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_session_questions_crisis_event ON public.crisis_session_questions(crisis_event_id);
CREATE INDEX idx_session_questions_therapist ON public.crisis_session_questions(therapist_name);
CREATE INDEX idx_session_questions_unanswered ON public.crisis_session_questions(answered_at) WHERE answered_at IS NULL;

-- 5. Rozšíření crisis_events
ALTER TABLE public.crisis_events
  ADD COLUMN IF NOT EXISTS morning_review_notes text,
  ADD COLUMN IF NOT EXISTS afternoon_review_notes text,
  ADD COLUMN IF NOT EXISTS evening_decision_notes text,
  ADD COLUMN IF NOT EXISTS post_session_review_notes text,
  ADD COLUMN IF NOT EXISTS next_day_plan_notes text,
  ADD COLUMN IF NOT EXISTS intervention_result_completeness numeric(3,1),
  ADD COLUMN IF NOT EXISTS required_outputs_today jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS awaiting_response_from_therapists jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS closure_meeting_id uuid,
  ADD COLUMN IF NOT EXISTS closure_statement text,
  ADD COLUMN IF NOT EXISTS operating_state text DEFAULT 'active';

-- FK for closure_meeting_id
ALTER TABLE public.crisis_events
  ADD CONSTRAINT fk_crisis_events_closure_meeting
  FOREIGN KEY (closure_meeting_id) REFERENCES public.did_meetings(id) ON DELETE SET NULL;

-- Index on operating_state for filtering active crises
CREATE INDEX idx_crisis_events_operating_state ON public.crisis_events(operating_state);

-- 6. Rozšíření did_meetings
ALTER TABLE public.did_meetings
  ADD COLUMN IF NOT EXISTS meeting_conclusions jsonb,
  ADD COLUMN IF NOT EXISTS hanka_position text,
  ADD COLUMN IF NOT EXISTS kata_position text,
  ADD COLUMN IF NOT EXISTS karel_final_statement text,
  ADD COLUMN IF NOT EXISTS is_closure_meeting boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS closure_recommendation text;
