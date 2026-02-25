
-- Kartotéka: tabulka klientů (karta klienta)
CREATE TABLE public.clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  name TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  diagnosis TEXT DEFAULT '',
  therapy_type TEXT DEFAULT '',
  referral_source TEXT DEFAULT '',
  key_history TEXT DEFAULT '',
  family_context TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own clients" ON public.clients FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own clients" ON public.clients FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own clients" ON public.clients FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own clients" ON public.clients FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_did_conversations_updated_at();

-- Kartotéka: záznamy ze sezení
CREATE TABLE public.client_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_number INTEGER,
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Data z Report formuláře
  report_context TEXT DEFAULT '',
  report_key_theme TEXT DEFAULT '',
  report_therapist_emotions TEXT[] DEFAULT '{}',
  report_transference TEXT DEFAULT '',
  report_risks TEXT[] DEFAULT '{}',
  report_missing_data TEXT DEFAULT '',
  report_interventions_tried TEXT DEFAULT '',
  report_next_session_goal TEXT DEFAULT '',
  -- AI analýza od Karla
  ai_analysis TEXT DEFAULT '',
  ai_hypotheses TEXT DEFAULT '',
  ai_recommended_methods TEXT DEFAULT '',
  ai_risk_assessment TEXT DEFAULT '',
  -- Hlasová analýza (vložení externích výsledků)
  voice_analysis TEXT DEFAULT '',
  -- Volné poznámky
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.client_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own client sessions" ON public.client_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own client sessions" ON public.client_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own client sessions" ON public.client_sessions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own client sessions" ON public.client_sessions FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_client_sessions_updated_at
  BEFORE UPDATE ON public.client_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_did_conversations_updated_at();

-- Kartotéka: úkoly a intervence
CREATE TABLE public.client_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  task TEXT NOT NULL,
  method TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'done', 'cancelled')),
  due_date DATE,
  result TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.client_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own client tasks" ON public.client_tasks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own client tasks" ON public.client_tasks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own client tasks" ON public.client_tasks FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own client tasks" ON public.client_tasks FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_client_tasks_updated_at
  BEFORE UPDATE ON public.client_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_did_conversations_updated_at();
