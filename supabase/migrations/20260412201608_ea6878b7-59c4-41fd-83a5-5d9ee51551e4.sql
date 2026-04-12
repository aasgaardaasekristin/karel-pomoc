-- 1. Ownership krize
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS primary_therapist text;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS secondary_therapist text;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS ownership_source text;

-- 2. Denní krizový cyklus
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS last_morning_review_at timestamptz;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS last_afternoon_review_at timestamptz;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS last_evening_decision_at timestamptz;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS last_outcome_recorded_at timestamptz;

-- 3. Koordinace a povinné výstupy
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS today_required_outputs jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS awaiting_response_from text[] DEFAULT '{}';

-- 4. Denní checklist
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS daily_checklist jsonb DEFAULT '{}'::jsonb;

-- 5. Krizová porada trigger
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS crisis_meeting_required boolean DEFAULT false;
ALTER TABLE public.crisis_events ADD COLUMN IF NOT EXISTS crisis_meeting_reason text;