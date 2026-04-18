-- BUGFIX: Canonical workspace identity for did_threads
-- Adds workspace_type (task | question | session | null) + workspace_id (UUID of source row)
-- so reopening the same task/question/session always lands in the same persistent thread,
-- instead of spawning a new "Karel" thread each time.

ALTER TABLE public.did_threads
  ADD COLUMN IF NOT EXISTS workspace_type text,
  ADD COLUMN IF NOT EXISTS workspace_id uuid;

-- Lookup index: per-user, per-workspace, ordered by recency.
-- Partial index keeps it tiny — only system-workspace threads are indexed,
-- regular cast/mamka/kata chat threads are unaffected.
CREATE INDEX IF NOT EXISTS idx_did_threads_workspace
  ON public.did_threads (user_id, workspace_type, workspace_id, last_activity_at DESC)
  WHERE workspace_type IS NOT NULL AND workspace_id IS NOT NULL;