-- client_analyses
CREATE TABLE client_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  version INT DEFAULT 1,
  content TEXT NOT NULL,
  summary TEXT
);
ALTER TABLE client_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own analyses" ON client_analyses FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own analyses" ON client_analyses FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own analyses" ON client_analyses FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- session_preparations
CREATE TABLE session_preparations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_number INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  plan JSONB NOT NULL,
  approved_at TIMESTAMPTZ,
  notes TEXT
);
ALTER TABLE session_preparations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own preparations" ON session_preparations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preparations" ON session_preparations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own preparations" ON session_preparations FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- session_materials
CREATE TABLE session_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_id UUID REFERENCES client_sessions(id),
  session_number INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  material_type TEXT NOT NULL,
  label TEXT,
  storage_url TEXT NOT NULL,
  analysis TEXT,
  tags TEXT[]
);
ALTER TABLE session_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own materials" ON session_materials FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own materials" ON session_materials FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own materials" ON session_materials FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('session-materials', 'session-materials', true);

-- Storage policies
CREATE POLICY "Authenticated users can upload session materials" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'session-materials');
CREATE POLICY "Public can read session materials" ON storage.objects FOR SELECT TO public USING (bucket_id = 'session-materials');
CREATE POLICY "Users can delete own session materials" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'session-materials');