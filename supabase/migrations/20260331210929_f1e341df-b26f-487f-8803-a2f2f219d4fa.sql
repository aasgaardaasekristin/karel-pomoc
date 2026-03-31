-- Extend Hana conversations with lightweight list metadata and topic linkage
ALTER TABLE public.karel_hana_conversations
  ADD COLUMN IF NOT EXISTS thread_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preview text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'hana',
  ADD COLUMN IF NOT EXISTS sub_mode text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS source_topic_id uuid;

CREATE INDEX IF NOT EXISTS idx_karel_hana_conversations_section_sub_mode_activity
  ON public.karel_hana_conversations (user_id, section, sub_mode, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_karel_hana_conversations_source_topic_id
  ON public.karel_hana_conversations (source_topic_id)
  WHERE source_topic_id IS NOT NULL;

-- Keep preview and message_count in sync with JSON messages payload
CREATE OR REPLACE FUNCTION public.update_hana_conversation_summary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  last_user_content text;
BEGIN
  NEW.message_count := COALESCE(jsonb_array_length(COALESCE(NEW.messages, '[]'::jsonb)), 0);

  SELECT NULLIF(btrim(elem->>'content'), '')
    INTO last_user_content
  FROM jsonb_array_elements(COALESCE(NEW.messages, '[]'::jsonb)) AS elem
  WHERE elem->>'role' = 'user'
  ORDER BY ordinality DESC
  LIMIT 1;

  IF last_user_content IS NULL THEN
    SELECT NULLIF(btrim(elem->>'content'), '')
      INTO last_user_content
    FROM jsonb_array_elements(COALESCE(NEW.messages, '[]'::jsonb)) WITH ORDINALITY AS arr(elem, ordinality)
    ORDER BY ordinality DESC
    LIMIT 1;
  END IF;

  NEW.preview := LEFT(REGEXP_REPLACE(COALESCE(last_user_content, ''), '\s+', ' ', 'g'), 180);

  IF COALESCE(NEW.thread_label, '') = '' AND COALESCE(NEW.preview, '') <> '' THEN
    NEW.thread_label := LEFT(NEW.preview, 80);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_hana_conversation_summary ON public.karel_hana_conversations;
CREATE TRIGGER trg_update_hana_conversation_summary
BEFORE INSERT OR UPDATE OF messages, thread_label
ON public.karel_hana_conversations
FOR EACH ROW
EXECUTE FUNCTION public.update_hana_conversation_summary();

-- Saved topics independent of source thread lifecycle
CREATE TABLE IF NOT EXISTS public.karel_saved_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  extracted_context text NOT NULL DEFAULT '',
  source_thread_id uuid,
  section text NOT NULL DEFAULT 'hana',
  sub_mode text NOT NULL DEFAULT 'personal',
  last_continued_at timestamp with time zone,
  synced_to_drive_at timestamp with time zone,
  pending_drive_sync boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_karel_saved_topics_user_active
  ON public.karel_saved_topics (user_id, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_karel_saved_topics_section_sub_mode
  ON public.karel_saved_topics (user_id, section, sub_mode, is_active, last_continued_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_karel_saved_topics_sync_queue
  ON public.karel_saved_topics (pending_drive_sync, synced_to_drive_at)
  WHERE is_active = true;

ALTER TABLE public.karel_saved_topics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own saved topics" ON public.karel_saved_topics;
CREATE POLICY "Users can read own saved topics"
ON public.karel_saved_topics
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own saved topics" ON public.karel_saved_topics;
CREATE POLICY "Users can create own saved topics"
ON public.karel_saved_topics
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own saved topics" ON public.karel_saved_topics;
CREATE POLICY "Users can update own saved topics"
ON public.karel_saved_topics
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own saved topics" ON public.karel_saved_topics;
CREATE POLICY "Users can delete own saved topics"
ON public.karel_saved_topics
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_karel_saved_topics_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_karel_saved_topics_updated_at ON public.karel_saved_topics;
CREATE TRIGGER trg_update_karel_saved_topics_updated_at
BEFORE UPDATE ON public.karel_saved_topics
FOR EACH ROW
EXECUTE FUNCTION public.update_karel_saved_topics_updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE public.karel_saved_topics;