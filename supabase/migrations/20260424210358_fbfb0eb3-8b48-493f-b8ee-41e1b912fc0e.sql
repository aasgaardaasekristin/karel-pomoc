CREATE TABLE IF NOT EXISTS public.did_team_agreements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'part',
  subject_id TEXT NOT NULL,
  agreement_text TEXT NOT NULL,
  implication_text TEXT,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  agreed_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_level TEXT NOT NULL DEFAULT 'D2',
  valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE,
  superseded_at TIMESTAMP WITH TIME ZONE,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.did_team_agreements ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_did_team_agreements_user_subject
ON public.did_team_agreements (user_id, subject_type, subject_id, superseded_at, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_did_team_agreements_source
ON public.did_team_agreements (source_table, source_record_id);

CREATE INDEX IF NOT EXISTS idx_did_team_agreements_active
ON public.did_team_agreements (user_id, priority, valid_from DESC)
WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION public.did_team_agreements_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_did_team_agreements_updated_at ON public.did_team_agreements;
CREATE TRIGGER trg_did_team_agreements_updated_at
BEFORE UPDATE ON public.did_team_agreements
FOR EACH ROW
EXECUTE FUNCTION public.did_team_agreements_set_updated_at();

DROP POLICY IF EXISTS "Users can read their own team agreements" ON public.did_team_agreements;
CREATE POLICY "Users can read their own team agreements"
ON public.did_team_agreements
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own team agreements" ON public.did_team_agreements;
CREATE POLICY "Users can create their own team agreements"
ON public.did_team_agreements
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own team agreements" ON public.did_team_agreements;
CREATE POLICY "Users can update their own team agreements"
ON public.did_team_agreements
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);