UPDATE public.did_update_cycles
SET status = 'failed_stale',
    last_error = 'p33_5_failed_daily_analyzer_500_ai_missing_required_fields',
    completed_at = COALESCE(completed_at, now())
WHERE id = '9a183062-8c31-48e3-9ff1-419843942e62';