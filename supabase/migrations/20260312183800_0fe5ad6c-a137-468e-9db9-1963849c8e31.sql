CREATE POLICY "Users can delete own update cycles"
ON public.did_update_cycles
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);