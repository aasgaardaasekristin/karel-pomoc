-- Helper for updated_at (idempotent)
CREATE OR REPLACE FUNCTION public.tdelib_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Team Deliberations: workflow object for Karel↔Hanka↔Káťa joint decisions
CREATE TABLE IF NOT EXISTS public.did_team_deliberations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,

  title TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'normal',
  deliberation_type TEXT NOT NULL DEFAULT 'team_task',

  subject_parts TEXT[] DEFAULT ARRAY[]::TEXT[],
  participants TEXT[] DEFAULT ARRAY['hanka','kata','karel']::TEXT[],
  created_by TEXT NOT NULL DEFAULT 'karel',

  initial_karel_brief TEXT,
  karel_proposed_plan TEXT,
  questions_for_hanka JSONB NOT NULL DEFAULT '[]'::jsonb,
  questions_for_kata JSONB NOT NULL DEFAULT '[]'::jsonb,

  discussion_log JSONB NOT NULL DEFAULT '[]'::jsonb,

  hanka_signed_at TIMESTAMPTZ,
  kata_signed_at TIMESTAMPTZ,
  karel_signed_at TIMESTAMPTZ,

  linked_live_session_id UUID,
  linked_task_id UUID,
  linked_drive_write_id UUID,
  linked_crisis_event_id UUID,

  final_summary TEXT,
  followup_needed BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,

  CONSTRAINT did_team_deliberations_status_chk
    CHECK (status IN ('draft','active','awaiting_signoff','approved','closed','archived')),
  CONSTRAINT did_team_deliberations_type_chk
    CHECK (deliberation_type IN ('team_task','session_plan','crisis','followup_review','supervision')),
  CONSTRAINT did_team_deliberations_priority_chk
    CHECK (priority IN ('low','normal','high','urgent','crisis'))
);

CREATE INDEX IF NOT EXISTS idx_did_team_delib_user_status
  ON public.did_team_deliberations (user_id, status);
CREATE INDEX IF NOT EXISTS idx_did_team_delib_type
  ON public.did_team_deliberations (deliberation_type);
CREATE INDEX IF NOT EXISTS idx_did_team_delib_priority
  ON public.did_team_deliberations (priority);
CREATE INDEX IF NOT EXISTS idx_did_team_delib_live_session
  ON public.did_team_deliberations (linked_live_session_id);
CREATE INDEX IF NOT EXISTS idx_did_team_delib_crisis
  ON public.did_team_deliberations (linked_crisis_event_id);

ALTER TABLE public.did_team_deliberations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own deliberations"
  ON public.did_team_deliberations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own deliberations"
  ON public.did_team_deliberations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own deliberations"
  ON public.did_team_deliberations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own deliberations"
  ON public.did_team_deliberations FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_did_team_delib_updated_at
  BEFORE UPDATE ON public.did_team_deliberations
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();

-- Auto-derive status from sign-offs
CREATE OR REPLACE FUNCTION public.did_team_delib_autoderive_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.hanka_signed_at IS NOT NULL
     AND NEW.kata_signed_at IS NOT NULL
     AND NEW.karel_signed_at IS NOT NULL
     AND NEW.status NOT IN ('approved','closed','archived') THEN
    NEW.status := 'approved';
  ELSIF (NEW.hanka_signed_at IS NOT NULL
         OR NEW.kata_signed_at IS NOT NULL
         OR NEW.karel_signed_at IS NOT NULL)
        AND (NEW.hanka_signed_at IS NULL
             OR NEW.kata_signed_at IS NULL
             OR NEW.karel_signed_at IS NULL)
        AND NEW.status IN ('draft','active') THEN
    NEW.status := 'awaiting_signoff';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_did_team_delib_autostatus
  BEFORE INSERT OR UPDATE OF hanka_signed_at, kata_signed_at, karel_signed_at
  ON public.did_team_deliberations
  FOR EACH ROW EXECUTE FUNCTION public.did_team_delib_autoderive_status();

ALTER TABLE public.did_team_deliberations REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.did_team_deliberations;