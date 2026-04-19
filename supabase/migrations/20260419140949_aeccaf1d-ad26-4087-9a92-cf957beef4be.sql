-- 1) Soft-archive duplicit did_threads (žádný DELETE).
--    Strategie:
--      - ponecháme nejnovější aktivní vlákno per (user_id, workspace_type, workspace_id)
--      - starší duplicity:
--          * nastavíme archive_status = 'duplicate'
--          * vynulujeme workspace_type/workspace_id, aby neblokovaly UNIQUE index
--    Tím se nemaže obsah zpráv, jen se přestane řešit jako kanonický target.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.did_threads WHERE archive_status IS NOT NULL) THEN
    -- archive_status už existuje, jen použít; nový enum 'duplicate' je free-text
    NULL;
  END IF;
END $$;

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
UPDATE public.did_threads d
SET archive_status = 'duplicate',
    workspace_type = NULL,
    workspace_id   = NULL
FROM ranked r
WHERE d.id = r.id AND r.rn > 1;

-- 2) did_team_deliberations.session_params — schválené parametry sezení
--    (kdo vede, formát, délka), aby bridge do did_daily_session_plans
--    nemusel hardcodovat hanka/individual.
ALTER TABLE public.did_team_deliberations
  ADD COLUMN IF NOT EXISTS session_params jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.did_team_deliberations.session_params IS
'Schválené parametry session_plan deliberation: { led_by: "Hanička"|"Káťa"|"společně", session_format: "individual"|"joint", duration_min: number, why_today: string }. Bridge do did_daily_session_plans čte primárně tento sloupec.';