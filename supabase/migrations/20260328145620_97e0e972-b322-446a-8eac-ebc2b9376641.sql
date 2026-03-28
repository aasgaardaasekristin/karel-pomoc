ALTER TABLE did_observations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS idx_did_observations_status ON did_observations(status);
CREATE INDEX IF NOT EXISTS idx_did_observations_source_ref ON did_observations(source_ref);
CREATE INDEX IF NOT EXISTS idx_did_observations_created_at ON did_observations(created_at);