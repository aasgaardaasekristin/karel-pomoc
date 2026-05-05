
ALTER TABLE public.dynamic_pipeline_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'frontend';

CREATE INDEX IF NOT EXISTS idx_dynamic_pipeline_state_type
  ON public.dynamic_pipeline_events (pipeline_state, surface_type, created_at DESC);

-- Allow service role to insert from edge functions on behalf of users
DROP POLICY IF EXISTS "service role full access pipeline events" ON public.dynamic_pipeline_events;
CREATE POLICY "service role full access pipeline events"
  ON public.dynamic_pipeline_events FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access activity sessions" ON public.active_app_activity_sessions;
CREATE POLICY "service role full access activity sessions"
  ON public.active_app_activity_sessions FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service role full access resume state" ON public.surface_resume_state;
CREATE POLICY "service role full access resume state"
  ON public.surface_resume_state FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
