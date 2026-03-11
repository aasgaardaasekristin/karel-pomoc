-- Track per-recipient daily report delivery to guarantee exactly-once semantics per day
CREATE TABLE IF NOT EXISTS public.did_daily_report_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cycle_id UUID NULL REFERENCES public.did_update_cycles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NULL,
  error_message TEXT NULL,
  CONSTRAINT did_daily_report_dispatches_recipient_check CHECK (recipient IN ('hanka', 'kata')),
  CONSTRAINT did_daily_report_dispatches_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT did_daily_report_dispatches_report_date_recipient_key UNIQUE (report_date, recipient)
);

ALTER TABLE public.did_daily_report_dispatches ENABLE ROW LEVEL SECURITY;

-- No direct client access; service-role backend function manages this table.
DROP POLICY IF EXISTS "No direct access to did_daily_report_dispatches" ON public.did_daily_report_dispatches;
CREATE POLICY "No direct access to did_daily_report_dispatches"
ON public.did_daily_report_dispatches
FOR ALL
TO authenticated
USING (false)
WITH CHECK (false);

DROP TRIGGER IF EXISTS set_did_daily_report_dispatches_updated_at ON public.did_daily_report_dispatches;
CREATE TRIGGER set_did_daily_report_dispatches_updated_at
BEFORE UPDATE ON public.did_daily_report_dispatches
FOR EACH ROW
EXECUTE FUNCTION public.set_did_conversations_updated_at();

CREATE INDEX IF NOT EXISTS idx_did_daily_report_dispatches_date_status
  ON public.did_daily_report_dispatches(report_date, status);