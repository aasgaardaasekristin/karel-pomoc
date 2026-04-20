-- Hardened forward-safe repair: delete duplicate empty deliberations
-- ONLY when ALL of these are true:
--  * no signatures, no synthesis, no discussion_log entries
--  * NO non-empty answer in questions_for_hanka
--  * NO non-empty answer in questions_for_kata
--  * an approved sibling for the same (user_id, linked_briefing_item_id) exists
-- Idempotent — safe to re-run; current audit shows 0 rows match.

DELETE FROM public.did_team_deliberations d
WHERE d.linked_briefing_item_id IS NOT NULL
  AND d.status IN ('draft','active','awaiting_signoff')
  AND d.hanka_signed_at IS NULL
  AND d.kata_signed_at IS NULL
  AND d.karel_signed_at IS NULL
  AND d.karel_synthesized_at IS NULL
  AND COALESCE(jsonb_array_length(d.discussion_log), 0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(d.questions_for_hanka, '[]'::jsonb)) q
    WHERE NULLIF(btrim(COALESCE(q->>'answer', '')), '') IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(d.questions_for_kata, '[]'::jsonb)) q
    WHERE NULLIF(btrim(COALESCE(q->>'answer', '')), '') IS NOT NULL
  )
  AND EXISTS (
    SELECT 1
    FROM public.did_team_deliberations sib
    WHERE sib.user_id = d.user_id
      AND sib.linked_briefing_item_id = d.linked_briefing_item_id
      AND sib.status = 'approved'
      AND sib.id <> d.id
  );