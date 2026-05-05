UPDATE public.did_pending_drive_writes
SET status = 'blocked_by_governance',
    pipeline_state = 'requires_manual_approval_physical_card_missing_or_ambiguous',
    next_retry_at = NULL,
    last_error_message = 'P29A: KARTA_GERHARDT has no unambiguous physical Drive card mapping; manual approval required'
WHERE target_document = 'KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GERHARDT';