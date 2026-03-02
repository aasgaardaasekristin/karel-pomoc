
-- Add is_processed tracking to did_conversations so daily cycle knows what's been processed
ALTER TABLE public.did_conversations
ADD COLUMN IF NOT EXISTS is_processed boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS processed_at timestamptz;
