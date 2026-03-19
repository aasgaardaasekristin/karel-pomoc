ALTER TABLE did_threads 
  ADD COLUMN IF NOT EXISTS thread_label text DEFAULT '',
  ADD COLUMN IF NOT EXISTS entered_name text DEFAULT '';