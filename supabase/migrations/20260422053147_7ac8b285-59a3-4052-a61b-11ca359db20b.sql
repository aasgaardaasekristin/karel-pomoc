-- PLAN-STATUS TRUTH FIX PASS — cleanup předchozí ručně inscenované porady a plánů
-- pro Tundrupek 2026-04-22, abychom mohli celý flow projít POUZE skrz edge funkce.
-- Toto NENÍ proof — toto je úklid předchozí inscenace, aby idempotence
-- karel-team-deliberation-create nevrátila staré reused záznamy.
DELETE FROM did_daily_session_plans
WHERE id IN (
  '2e437a6c-da56-4790-99ae-696d077df0be',
  '1a2705d6-d62c-436b-ac1f-f89f64c047db'
);

DELETE FROM did_team_deliberations
WHERE id = 'f20bc4a1-f356-4c3a-acaf-232f35ca9a07';