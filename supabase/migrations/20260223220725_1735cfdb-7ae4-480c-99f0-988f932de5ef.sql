-- DID conversation history synchronized per authenticated user
CREATE TABLE IF NOT EXISTS public.did_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_id TEXT NOT NULL,
  sub_mode TEXT NOT NULL,
  label TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  did_initial_context TEXT NOT NULL DEFAULT '',
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id)
);

ALTER TABLE public.did_conversations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'did_conversations' AND policyname = 'Users can read own DID conversations'
  ) THEN
    CREATE POLICY "Users can read own DID conversations"
    ON public.did_conversations
    FOR SELECT
    USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'did_conversations' AND policyname = 'Users can insert own DID conversations'
  ) THEN
    CREATE POLICY "Users can insert own DID conversations"
    ON public.did_conversations
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'did_conversations' AND policyname = 'Users can update own DID conversations'
  ) THEN
    CREATE POLICY "Users can update own DID conversations"
    ON public.did_conversations
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'did_conversations' AND policyname = 'Users can delete own DID conversations'
  ) THEN
    CREATE POLICY "Users can delete own DID conversations"
    ON public.did_conversations
    FOR DELETE
    USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_did_conversations_user_saved_at
  ON public.did_conversations (user_id, saved_at DESC);

CREATE OR REPLACE FUNCTION public.set_did_conversations_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_did_conversations_updated_at ON public.did_conversations;
CREATE TRIGGER trg_did_conversations_updated_at
BEFORE UPDATE ON public.did_conversations
FOR EACH ROW
EXECUTE FUNCTION public.set_did_conversations_updated_at();