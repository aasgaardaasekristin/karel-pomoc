CREATE TABLE IF NOT EXISTS public.did_part_registry_observer_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  call_site TEXT NOT NULL,
  attempted_name TEXT NOT NULL,
  context_data JSONB,
  lookup_result TEXT NOT NULL,
  matched_part_id UUID,
  action_taken TEXT NOT NULL
);

ALTER TABLE public.did_part_registry_observer_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_observer_log_observed_at
  ON public.did_part_registry_observer_log (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observer_log_call_site
  ON public.did_part_registry_observer_log (call_site, observed_at DESC);