-- Knihovna terapeutických manuálů (sdílená napříč všemi částmi)
CREATE TABLE public.karel_method_library (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  method_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  age_range TEXT,
  manual_md TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  contraindications TEXT,
  created_by TEXT NOT NULL DEFAULT 'karel',
  status TEXT NOT NULL DEFAULT 'active',
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_karel_method_library_category ON public.karel_method_library(category);
CREATE INDEX idx_karel_method_library_status ON public.karel_method_library(status);
CREATE INDEX idx_karel_method_library_tags ON public.karel_method_library USING GIN(tags);

ALTER TABLE public.karel_method_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read method library"
  ON public.karel_method_library FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can insert into method library"
  ON public.karel_method_library FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update method library"
  ON public.karel_method_library FOR UPDATE
  TO authenticated USING (true);

CREATE TRIGGER update_karel_method_library_updated_at
  BEFORE UPDATE ON public.karel_method_library
  FOR EACH ROW EXECUTE FUNCTION public.update_karel_saved_topics_updated_at();

-- Per-part historie použitých metod a jejich účinnosti
CREATE TABLE public.did_part_method_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  part_id TEXT NOT NULL,
  part_name TEXT,
  method_key TEXT NOT NULL,
  method_library_id UUID REFERENCES public.karel_method_library(id) ON DELETE SET NULL,
  variant_used TEXT,
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  session_id TEXT,
  clinical_yield SMALLINT CHECK (clinical_yield BETWEEN 1 AND 5),
  tolerance SMALLINT CHECK (tolerance BETWEEN 1 AND 5),
  trauma_marker BOOLEAN NOT NULL DEFAULT false,
  notes_md TEXT,
  next_step_hint TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_did_part_method_history_part ON public.did_part_method_history(part_id);
CREATE INDEX idx_did_part_method_history_method ON public.did_part_method_history(method_key);
CREATE INDEX idx_did_part_method_history_date ON public.did_part_method_history(session_date DESC);

ALTER TABLE public.did_part_method_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read part method history"
  ON public.did_part_method_history FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated can insert part method history"
  ON public.did_part_method_history FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update part method history"
  ON public.did_part_method_history FOR UPDATE
  TO authenticated USING (true);

CREATE TRIGGER update_did_part_method_history_updated_at
  BEFORE UPDATE ON public.did_part_method_history
  FOR EACH ROW EXECUTE FUNCTION public.update_karel_saved_topics_updated_at();