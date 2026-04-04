CREATE TABLE public.context_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  function_name TEXT NOT NULL,
  cache_key TEXT NOT NULL DEFAULT '',
  context_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_context_cache_lookup ON public.context_cache (user_id, function_name, cache_key);

ALTER TABLE public.context_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own cache"
ON public.context_cache FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own cache"
ON public.context_cache FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own cache"
ON public.context_cache FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
ON public.context_cache FOR ALL
TO service_role
USING (true)
WITH CHECK (true);