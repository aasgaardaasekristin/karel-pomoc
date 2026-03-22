ALTER TABLE client_tasks
  ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS for_session integer,
  ADD COLUMN IF NOT EXISTS answer text DEFAULT '';