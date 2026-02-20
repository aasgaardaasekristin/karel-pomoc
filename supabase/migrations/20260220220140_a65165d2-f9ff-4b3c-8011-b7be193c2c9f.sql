
-- Drop permissive policies
DROP POLICY IF EXISTS "Anyone can read crisis briefs" ON crisis_briefs;
DROP POLICY IF EXISTS "Anyone can update crisis briefs" ON crisis_briefs;
DROP POLICY IF EXISTS "Edge functions can insert crisis briefs" ON crisis_briefs;

-- Authenticated users can read crisis briefs
CREATE POLICY "Authenticated users can read crisis briefs"
ON crisis_briefs FOR SELECT
TO authenticated
USING (true);

-- Authenticated users can update crisis briefs (mark as read etc.)
CREATE POLICY "Authenticated users can update crisis briefs"
ON crisis_briefs FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Service role can insert crisis briefs (edge functions use service_role key)
CREATE POLICY "Service role can insert crisis briefs"
ON crisis_briefs FOR INSERT
TO service_role
WITH CHECK (true);
