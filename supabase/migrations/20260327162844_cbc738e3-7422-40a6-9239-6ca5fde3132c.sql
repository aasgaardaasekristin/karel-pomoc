DELETE FROM crisis_tasks;
DELETE FROM crisis_alerts;
DELETE FROM did_therapist_tasks WHERE task LIKE '%KRIZ%' OR task LIKE '%⚠️%';
DELETE FROM did_meetings WHERE topic LIKE '%KRIZ%';
DELETE FROM did_threads WHERE sub_mode = 'crisis';