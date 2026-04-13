
ALTER TABLE public.did_doc_sync_log 
  ADD COLUMN IF NOT EXISTS content_type text DEFAULT '',
  ADD COLUMN IF NOT EXISTS subject_type text DEFAULT '',
  ADD COLUMN IF NOT EXISTS subject_id text DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_doc_sync_log_content_type ON public.did_doc_sync_log(content_type);
CREATE INDEX IF NOT EXISTS idx_doc_sync_log_target ON public.did_doc_sync_log(target_document);
