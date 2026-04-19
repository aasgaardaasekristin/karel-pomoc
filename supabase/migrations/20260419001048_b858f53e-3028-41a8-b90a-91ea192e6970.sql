-- Tabulka pro kanonický denní briefing Karla
CREATE TABLE public.did_daily_briefings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  briefing_date DATE NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_session_part_id UUID,
  proposed_session_score NUMERIC,
  decisions_count INTEGER NOT NULL DEFAULT 0,
  generation_method TEXT NOT NULL DEFAULT 'manual',
  generation_duration_ms INTEGER,
  model_used TEXT,
  is_stale BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index pro rychlé načítání nejnovějšího briefingu
CREATE INDEX idx_did_daily_briefings_date_desc ON public.did_daily_briefings (briefing_date DESC, generated_at DESC);

-- Unique constraint: jeden aktivní briefing per den (poslední vyhrává v selektech, ale držíme všechny pro audit)
CREATE INDEX idx_did_daily_briefings_stale ON public.did_daily_briefings (is_stale) WHERE is_stale = false;

-- Enable RLS
ALTER TABLE public.did_daily_briefings ENABLE ROW LEVEL SECURITY;

-- Read: každý přihlášený uživatel
CREATE POLICY "Authenticated users can read briefings"
ON public.did_daily_briefings
FOR SELECT
TO authenticated
USING (true);

-- Insert/Update/Delete: jen service role (edge funkce)
CREATE POLICY "Service role can insert briefings"
ON public.did_daily_briefings
FOR INSERT
TO service_role
WITH CHECK (true);

CREATE POLICY "Service role can update briefings"
ON public.did_daily_briefings
FOR UPDATE
TO service_role
USING (true);

-- Trigger pro updated_at
CREATE TRIGGER update_did_daily_briefings_updated_at
BEFORE UPDATE ON public.did_daily_briefings
FOR EACH ROW
EXECUTE FUNCTION public.tdelib_set_updated_at();