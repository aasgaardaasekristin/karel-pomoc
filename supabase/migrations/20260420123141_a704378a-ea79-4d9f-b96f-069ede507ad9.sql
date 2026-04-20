-- Backfill: legacy enum value 'done' → canonical 'completed'.
-- The current drive-queue-processor uses only 'completed', 'failed', 'failed_permanent', 'skipped', 'pending'.
-- Old rows with status='done' come from a previous processor build and skew audit counts.
UPDATE public.did_pending_drive_writes
SET status = 'completed'
WHERE status = 'done';