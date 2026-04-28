CREATE TABLE IF NOT EXISTS public.briefing_ask_resolutions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  briefing_id UUID NOT NULL,
  ask_id TEXT NOT NULL,
  thread_id UUID NULL,
  assignee TEXT NOT NULL CHECK (assignee IN ('hanka','kata')),
  therapist_response TEXT NULL,
  response_hash TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'none' CHECK (intent IN ('session_plan','playroom_plan','team_coordination','task','observation','current_handling','none')),
  target_type TEXT NOT NULL DEFAULT 'none' CHECK (target_type IN ('proposed_session','proposed_playroom','team_deliberation','current_handling','task','none')),
  target_item_id TEXT NULL,
  target_part_name TEXT NULL,
  resolution_mode TEXT NOT NULL CHECK (resolution_mode IN ('apply_to_program','apply_to_deliberation','store_observation','create_task','close_no_change')),
  resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending','applied_to_program','stored_as_observation','created_task','closed_no_change','needs_clarification','failed_retry')),
  applied_to_deliberation_id UUID NULL,
  applied_to_program_version TEXT NULL,
  applied_to_plan_id UUID NULL,
  applied_to_target_type TEXT NULL,
  applied_to_target_item_id TEXT NULL,
  error_message TEXT NULL,
  processed_at TIMESTAMP WITH TIME ZONE NULL,
  processed_by TEXT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.briefing_ask_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own briefing ask resolutions"
ON public.briefing_ask_resolutions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own briefing ask resolutions"
ON public.briefing_ask_resolutions
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own briefing ask resolutions"
ON public.briefing_ask_resolutions
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_briefing_ask_resolution_dedupe
ON public.briefing_ask_resolutions (
  user_id,
  briefing_id,
  ask_id,
  COALESCE(thread_id, '00000000-0000-0000-0000-000000000000'::uuid),
  target_type,
  COALESCE(target_item_id, ''),
  response_hash
);

CREATE INDEX IF NOT EXISTS idx_briefing_ask_resolutions_briefing
ON public.briefing_ask_resolutions (briefing_id, ask_id);

CREATE INDEX IF NOT EXISTS idx_briefing_ask_resolutions_thread
ON public.briefing_ask_resolutions (thread_id);

CREATE OR REPLACE FUNCTION public.briefing_ask_resolutions_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_briefing_ask_resolutions_updated_at ON public.briefing_ask_resolutions;
CREATE TRIGGER set_briefing_ask_resolutions_updated_at
BEFORE UPDATE ON public.briefing_ask_resolutions
FOR EACH ROW
EXECUTE FUNCTION public.briefing_ask_resolutions_set_updated_at();