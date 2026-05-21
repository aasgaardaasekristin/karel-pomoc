ALTER TABLE public.did_part_registry
    ADD COLUMN IF NOT EXISTS drive_doc_id text;

COMMENT ON COLUMN public.did_part_registry.drive_doc_id IS
'Google Doc fileId kanonické karty A–M (preferováno před name-lookup)';