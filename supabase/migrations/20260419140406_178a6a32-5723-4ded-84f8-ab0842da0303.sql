-- HARDENING PASS po Slice 3: DB-level idempotence pro briefing-bound objekty.
--
-- 1) did_team_deliberations: max 1 AKTIVNÍ porada per (user_id, linked_briefing_item_id).
--    Stavy active|awaiting_signoff|draft = "živá" porada. Po approved/closed/archived
--    se může pro stejný briefing item teoreticky vznikne nová (jiný den, znovu otevřená
--    diskuse), ale aktivní smí být jen jedna.
--
-- 2) did_threads: max 1 vlákno per (user_id, workspace_type, workspace_id).
--    Tato kombinace je kanonický identity-key pro briefing ask thread (ask_hanka/ask_kata).
--    Vynucuje idempotenci i při double-clicku / race condition na klientu.

-- ── 1) did_team_deliberations ────────────────────────────────────────
-- Vyčistit potenciální duplicity ze Slice 3 vývoje, jinak by index selhal.
-- Ponecháme nejnovější aktivní záznam, starší duplicity zarchivujeme.
WITH ranked AS (
  SELECT id,
         linked_briefing_item_id,
         user_id,
         status,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, linked_briefing_item_id
           ORDER BY created_at DESC
         ) AS rn
  FROM public.did_team_deliberations
  WHERE linked_briefing_item_id IS NOT NULL
    AND status IN ('draft','active','awaiting_signoff')
)
UPDATE public.did_team_deliberations d
SET status = 'archived'
FROM ranked r
WHERE d.id = r.id AND r.rn > 1;

-- Smaž starý non-unique index (nahrazujeme ho UNIQUE verzí).
DROP INDEX IF EXISTS public.idx_did_team_delib_briefing_item;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_did_team_delib_active_briefing_item
  ON public.did_team_deliberations (user_id, linked_briefing_item_id)
  WHERE linked_briefing_item_id IS NOT NULL
    AND status IN ('draft','active','awaiting_signoff');

-- ── 2) did_threads ───────────────────────────────────────────────────
-- Vyčistit potenciální duplicity (ponecháme nejaktivnější).
WITH ranked AS (
  SELECT id,
         user_id,
         workspace_type,
         workspace_id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, workspace_type, workspace_id
           ORDER BY COALESCE(last_activity_at, created_at) DESC
         ) AS rn
  FROM public.did_threads
  WHERE workspace_type IS NOT NULL
    AND workspace_id   IS NOT NULL
)
DELETE FROM public.did_threads d
USING ranked r
WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_did_threads_workspace
  ON public.did_threads (user_id, workspace_type, workspace_id)
  WHERE workspace_type IS NOT NULL
    AND workspace_id   IS NOT NULL;