
-- 1. Přepsat trigger: 2 podpisy stačí, Karel jen audit
CREATE OR REPLACE FUNCTION public.did_team_delib_autoderive_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.hanka_signed_at IS NOT NULL
     AND NEW.kata_signed_at IS NOT NULL
     AND NEW.status NOT IN ('approved','closed','archived') THEN
    NEW.status := 'approved';
    NEW.karel_signed_at := COALESCE(NEW.karel_signed_at, now());
  ELSIF (NEW.hanka_signed_at IS NOT NULL OR NEW.kata_signed_at IS NOT NULL)
        AND (NEW.hanka_signed_at IS NULL OR NEW.kata_signed_at IS NULL)
        AND NEW.status IN ('draft','active') THEN
    NEW.status := 'awaiting_signoff';
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Nové sloupce v did_team_deliberations
ALTER TABLE public.did_team_deliberations
  ADD COLUMN IF NOT EXISTS program_draft jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS interrogation_complete boolean NOT NULL DEFAULT false;

-- 3. Spižírna — balíčky čekající na noční propis do Drive
CREATE TABLE IF NOT EXISTS public.did_pantry_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  package_type text NOT NULL,
  source_id uuid,
  source_table text,
  content_md text NOT NULL,
  drive_target_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending_drive',
  flushed_at timestamptz,
  flush_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pantry_status_created ON public.did_pantry_packages (status, created_at);
CREATE INDEX IF NOT EXISTS idx_pantry_user ON public.did_pantry_packages (user_id);

ALTER TABLE public.did_pantry_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Pantry select own" ON public.did_pantry_packages
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Pantry insert own" ON public.did_pantry_packages
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Pantry update own" ON public.did_pantry_packages
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Pantry delete own" ON public.did_pantry_packages
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER trg_pantry_updated_at
  BEFORE UPDATE ON public.did_pantry_packages
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();
