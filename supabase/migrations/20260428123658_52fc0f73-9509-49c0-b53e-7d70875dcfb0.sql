ALTER TABLE public.did_daily_briefings
ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS idx_did_daily_briefings_user_id_generated_at
ON public.did_daily_briefings (user_id, generated_at DESC);

DROP POLICY IF EXISTS "Authenticated users can read briefings" ON public.did_daily_briefings;
DROP POLICY IF EXISTS "Users can read own did daily briefings" ON public.did_daily_briefings;
CREATE POLICY "Users can read own did daily briefings"
ON public.did_daily_briefings
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert briefings" ON public.did_daily_briefings;
CREATE POLICY "Service role can insert briefings"
ON public.did_daily_briefings
FOR INSERT
TO service_role
WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update briefings" ON public.did_daily_briefings;
CREATE POLICY "Service role can update briefings"
ON public.did_daily_briefings
FOR UPDATE
TO service_role
USING (true)
WITH CHECK (true);

ALTER TABLE public.safety_alerts
ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS idx_safety_alerts_user_id_created_at
ON public.safety_alerts (user_id, created_at DESC);

DROP POLICY IF EXISTS "auth_all_safety_alerts" ON public.safety_alerts;
DROP POLICY IF EXISTS "Users can read own safety alerts" ON public.safety_alerts;
CREATE POLICY "Users can read own safety alerts"
ON public.safety_alerts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own safety alerts" ON public.safety_alerts;
CREATE POLICY "Users can update own safety alerts"
ON public.safety_alerts
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage safety alerts" ON public.safety_alerts;
CREATE POLICY "Service role can manage safety alerts"
ON public.safety_alerts
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);