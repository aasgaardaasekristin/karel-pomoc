
DROP INDEX IF EXISTS public.uniq_did_team_delib_active_briefing_item;

CREATE UNIQUE INDEX uniq_did_team_delib_briefing_item
  ON public.did_team_deliberations (user_id, linked_briefing_item_id)
  WHERE linked_briefing_item_id IS NOT NULL
    AND status IN ('draft','active','awaiting_signoff','approved');
