
CREATE TABLE IF NOT EXISTS public.system_health_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  details jsonb DEFAULT '{}',
  resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.system_health_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view system health"
  ON public.system_health_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update system health"
  ON public.system_health_log FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full insert on system_health_log"
  ON public.system_health_log FOR INSERT
  WITH CHECK (true);

CREATE INDEX idx_system_health_severity
  ON public.system_health_log(severity, resolved);

CREATE TABLE IF NOT EXISTS public.did_pending_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL,
  to_name text,
  subject text NOT NULL,
  body_html text NOT NULL,
  body_text text,
  email_type text NOT NULL DEFAULT 'escalation',
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  retry_count int DEFAULT 0,
  max_retries int DEFAULT 3,
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz,
  next_retry_at timestamptz DEFAULT now()
);

ALTER TABLE public.did_pending_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view pending emails"
  ON public.did_pending_emails FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role full insert on did_pending_emails"
  ON public.did_pending_emails FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role full update on did_pending_emails"
  ON public.did_pending_emails FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_pending_emails_status
  ON public.did_pending_emails(status, next_retry_at);
