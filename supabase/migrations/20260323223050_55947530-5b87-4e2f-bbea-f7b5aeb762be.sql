ALTER TABLE clients ADD COLUMN IF NOT EXISTS drive_last_synced_at timestamptz DEFAULT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_drive_doc_id_unique UNIQUE (drive_doc_id);