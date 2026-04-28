ALTER TABLE public.did_session_reviews
DROP CONSTRAINT IF EXISTS did_session_reviews_status_check;

ALTER TABLE public.did_session_reviews
ADD CONSTRAINT did_session_reviews_status_check
CHECK (
  status = ANY (
    ARRAY[
      'pending_review'::text,
      'analysis_running'::text,
      'analyzed'::text,
      'partially_analyzed'::text,
      'evidence_limited'::text,
      'failed_analysis'::text,
      'failed_retry'::text,
      'cancelled'::text
    ]
  )
);

CREATE INDEX IF NOT EXISTS idx_did_session_reviews_playroom_current
ON public.did_session_reviews (session_date DESC, mode, review_kind, is_current, created_at DESC)
WHERE mode = 'playroom';