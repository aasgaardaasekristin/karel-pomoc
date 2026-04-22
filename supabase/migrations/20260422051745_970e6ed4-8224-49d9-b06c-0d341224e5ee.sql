UPDATE did_daily_briefings SET proposed_session_part_id = 'ddcb5216-3ae5-41fa-bbd5-b867c0e45d19', proposed_session_score = 9, updated_at = now() WHERE id IN (SELECT id FROM did_daily_briefings WHERE briefing_date = '2026-04-22' AND payload->'proposed_session' IS NOT NULL ORDER BY generated_at DESC LIMIT 1);

UPDATE did_daily_session_plans SET status = 'approved', updated_at = now() WHERE id = '2e437a6c-da56-4790-99ae-696d077df0be';

UPDATE did_daily_session_plans SET status = 'superseded', updated_at = now() WHERE id = '1a2705d6-d62c-436b-ac1f-f89f64c047db';