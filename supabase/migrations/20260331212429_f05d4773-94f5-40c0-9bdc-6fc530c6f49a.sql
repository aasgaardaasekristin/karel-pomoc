CREATE OR REPLACE FUNCTION public.update_hana_conversation_summary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  last_user_content text;
BEGIN
  NEW.message_count := COALESCE(jsonb_array_length(COALESCE(NEW.messages, '[]'::jsonb)), 0);

  SELECT NULLIF(btrim(arr.elem->>'content'), '')
    INTO last_user_content
  FROM jsonb_array_elements(COALESCE(NEW.messages, '[]'::jsonb)) WITH ORDINALITY AS arr(elem, ordinality)
  WHERE arr.elem->>'role' = 'user'
  ORDER BY arr.ordinality DESC
  LIMIT 1;

  IF last_user_content IS NULL THEN
    SELECT NULLIF(btrim(arr.elem->>'content'), '')
      INTO last_user_content
    FROM jsonb_array_elements(COALESCE(NEW.messages, '[]'::jsonb)) WITH ORDINALITY AS arr(elem, ordinality)
    ORDER BY arr.ordinality DESC
    LIMIT 1;
  END IF;

  NEW.preview := LEFT(REGEXP_REPLACE(COALESCE(last_user_content, ''), '\s+', ' ', 'g'), 180);

  IF COALESCE(NEW.thread_label, '') = '' AND COALESCE(NEW.preview, '') <> '' THEN
    NEW.thread_label := LEFT(NEW.preview, 80);
  END IF;

  RETURN NEW;
END;
$$;

UPDATE public.karel_hana_conversations
SET messages = COALESCE(messages, '[]'::jsonb)
WHERE COALESCE(message_count, 0) = 0
  AND (
    COALESCE(preview, '') = ''
    OR jsonb_array_length(COALESCE(messages, '[]'::jsonb)) > 0
  );