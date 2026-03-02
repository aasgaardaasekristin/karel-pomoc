
-- Table for DID thread-per-part: each part gets its own 24h thread
CREATE TABLE public.did_threads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  part_name TEXT NOT NULL,
  part_language TEXT DEFAULT 'cs',
  sub_mode TEXT NOT NULL DEFAULT 'cast',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  is_processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_did_threads_user_submode ON public.did_threads(user_id, sub_mode, is_processed);
CREATE INDEX idx_did_threads_part ON public.did_threads(user_id, part_name, is_processed);

-- Enable RLS
ALTER TABLE public.did_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own DID threads"
ON public.did_threads FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own DID threads"
ON public.did_threads FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own DID threads"
ON public.did_threads FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own DID threads"
ON public.did_threads FOR DELETE
USING (auth.uid() = user_id);

-- Table for tracking daily update cycles
CREATE TABLE public.did_update_cycles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  cycle_type TEXT NOT NULL DEFAULT 'daily',
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'running',
  report_summary TEXT,
  cards_updated JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.did_update_cycles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own update cycles"
ON public.did_update_cycles FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own update cycles"
ON public.did_update_cycles FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own update cycles"
ON public.did_update_cycles FOR UPDATE
USING (auth.uid() = user_id);
