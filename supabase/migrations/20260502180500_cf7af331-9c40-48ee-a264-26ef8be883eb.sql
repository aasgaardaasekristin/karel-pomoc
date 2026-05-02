CREATE TABLE IF NOT EXISTS public.did_acceptance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','not_accepted','partial','blocked')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  failed_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS did_acceptance_runs_pass_generated_idx
  ON public.did_acceptance_runs (pass_name, generated_at DESC);

ALTER TABLE public.did_acceptance_runs ENABLE ROW LEVEL SECURITY;

-- Canonical DID user can read own + system (created_by IS NULL) runs.
CREATE POLICY "acceptance_runs_canonical_user_read"
  ON public.did_acceptance_runs
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = public.get_canonical_did_user_id()
    AND (created_by IS NULL OR created_by = auth.uid())
  );

-- Service role bypass je default; explicit insert policy aby šlo zapisovat z edge funkce s service role (nepotřebné, ale pro jistotu žádná INSERT policy = blokuje authenticated INSERT — což chceme).
-- Záměrně NEpovolujeme UPDATE/DELETE pro nikoho z PostgREST cesty.