DELETE FROM did_therapist_tasks WHERE task LIKE '%KRIZOV%' OR task LIKE '%TELEFONÁT%' OR task LIKE '%PŘÍPRAVA%SEZENÍ%' OR task LIKE '%Aktualizace dat pro krizov%' OR task LIKE '%KOORDINACE KRIZOVÉ%' OR task LIKE '%VEČERNÍ%SEZENÍ%KRIZOV%' OR task LIKE '%VEČERNÍ KRIZOVÉ%';
DELETE FROM crisis_tasks;
DELETE FROM crisis_alerts;
DELETE FROM did_meetings WHERE topic LIKE '%KRIZOVÁ PORADA%';
DELETE FROM did_threads WHERE sub_mode = 'crisis';
DELETE FROM did_daily_session_plans WHERE plan_date < CURRENT_DATE - 1 AND status = 'generated';