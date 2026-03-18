CREATE POLICY "Authenticated users can upload theme backgrounds"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'theme-backgrounds');

CREATE POLICY "Anyone can view theme backgrounds"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'theme-backgrounds');

CREATE POLICY "Users can delete own theme backgrounds"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'theme-backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);