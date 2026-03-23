
CREATE TABLE session_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  session_date date NOT NULL DEFAULT CURRENT_DATE,
  media_type text NOT NULL,
  storage_path text NOT NULL,
  original_filename text,
  ai_analysis jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE session_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own media" ON session_media FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

INSERT INTO storage.buckets (id, name, public) VALUES ('session-media', 'session-media', false);
CREATE POLICY "Auth upload session media" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'session-media');
CREATE POLICY "Auth read session media" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'session-media');
CREATE POLICY "Auth delete session media" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'session-media');
