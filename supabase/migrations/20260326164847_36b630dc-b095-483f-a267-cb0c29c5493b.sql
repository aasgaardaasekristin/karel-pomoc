
DELETE FROM thread_processing_log WHERE thread_id = '4b3afd45-6fb3-4a00-b966-debae58e5eb6';
UPDATE did_threads SET is_processed = false, processed_at = NULL WHERE id = '4b3afd45-6fb3-4a00-b966-debae58e5eb6';
