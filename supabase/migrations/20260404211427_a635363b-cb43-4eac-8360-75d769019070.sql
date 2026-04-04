DROP POLICY "Service role full access to research cache" ON public.did_research_cache;

CREATE POLICY "Service role can manage research cache"
  ON public.did_research_cache FOR ALL
  USING (auth.uid() = user_id OR current_setting('role') = 'service_role')
  WITH CHECK (auth.uid() = user_id OR current_setting('role') = 'service_role');