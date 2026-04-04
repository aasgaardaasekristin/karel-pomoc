CREATE TABLE public.did_research_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  part_name TEXT NOT NULL,
  query TEXT NOT NULL,
  result TEXT NOT NULL,
  citations TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_in_cards BOOLEAN DEFAULT false,
  tags TEXT[] DEFAULT '{}'
);

CREATE INDEX idx_did_research_cache_lookup ON public.did_research_cache (user_id, part_name, created_at DESC);

ALTER TABLE public.did_research_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own research cache"
  ON public.did_research_cache FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own research cache"
  ON public.did_research_cache FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to research cache"
  ON public.did_research_cache FOR ALL
  USING (true)
  WITH CHECK (true);