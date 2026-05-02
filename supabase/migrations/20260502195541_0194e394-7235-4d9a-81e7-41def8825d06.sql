-- ============================================================================
-- P6: Operational SLO Coverage Registry
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.did_operational_slo_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'pipeline',
  description TEXT,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  staleness_minutes INTEGER,
  expected_max_staleness_minutes INTEGER NOT NULL DEFAULT 1440,
  status TEXT NOT NULL DEFAULT 'not_implemented'
    CHECK (status IN ('ok','degraded','failed','not_implemented')),
  evidence_ref TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_action TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_did_op_slo_status ON public.did_operational_slo_checks(status);
CREATE INDEX IF NOT EXISTS idx_did_op_slo_last_run ON public.did_operational_slo_checks(last_run_at DESC);

ALTER TABLE public.did_operational_slo_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "canonical_did_user_can_read_slo"
  ON public.did_operational_slo_checks FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id());

CREATE POLICY "service_role_can_write_slo"
  ON public.did_operational_slo_checks FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_did_op_slo_set_updated_at
  BEFORE UPDATE ON public.did_operational_slo_checks
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();

-- Seed all known pipelines as not_implemented (will be updated by sentinel/runner)
INSERT INTO public.did_operational_slo_checks (pipeline_name, category, description, expected_max_staleness_minutes, status)
VALUES
  ('morning_daily_cycle','pipeline','Ranní hlavní cyklus',1440,'not_implemented'),
  ('morning_karel_briefing','briefing','Karlův přehled (fresh, non-fallback)',1440,'not_implemented'),
  ('briefing_sla_watchdog','watchdog','SLA watchdog briefingu',360,'not_implemented'),
  ('pantry_b_flush','memory','Pantry B implications/tasks flush',1440,'not_implemented'),
  ('drive_write_queue','drive','Drive write queue zpracování',360,'not_implemented'),
  ('drive_flush_to_archive','drive','Drive flush do archivu',1440,'not_implemented'),
  ('drive_to_pantry_refresh','drive','Drive → Pantry refresh (intentionally not implemented)',1440,'not_implemented'),
  ('did_implications_writeback','writeback','Zápis implikací do kartotéky',1440,'not_implemented'),
  ('did_therapist_tasks_carryover','tasks','Carry-over úkolů pro terapeutky',1440,'not_implemented'),
  ('session_plan_generation','session','Generování plánu sezení',1440,'not_implemented'),
  ('session_start_path','session','Start sezení (sync_and_start)',1440,'not_implemented'),
  ('live_session_state_machine','session','State machine live sezení',1440,'not_implemented'),
  ('session_evaluation','session','Vyhodnocení sezení',1440,'not_implemented'),
  ('playroom_plan_generation','playroom','Návrh Herny',1440,'not_implemented'),
  ('playroom_evaluation','playroom','Vyhodnocení Herny',1440,'not_implemented'),
  ('part_profile_writeback','kartoteka','Update profilu části',1440,'not_implemented'),
  ('therapist_profile_update','profile','Update profilu Hanky/Káti',1440,'not_implemented'),
  ('kartoteka_update','kartoteka','Aktualizace kartotéky částí',1440,'not_implemented'),
  ('external_reality_watch','sentinel','Externí realita / internet sentinel',1440,'not_implemented'),
  ('professional_acceptance_runner','acceptance','Acceptance runner (P1–P5)',2880,'not_implemented')
ON CONFLICT (pipeline_name) DO NOTHING;

-- ============================================================================
-- P7: External Reality Sentinel — datový model
-- ============================================================================

-- 1) external_reality_events
CREATE TABLE IF NOT EXISTS public.external_reality_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  event_title TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'other'
    CHECK (event_type IN (
      'animal_suffering','child_abuse','public_trial','disaster','war',
      'rescue_failure','death','anniversary','other'
    )),
  source_type TEXT NOT NULL
    CHECK (source_type IN (
      'therapist_report','internet_news','social_web','calendar','child_part_mention'
    )),
  source_url TEXT,
  source_domain TEXT,
  source_reliability TEXT DEFAULT 'unknown'
    CHECK (source_reliability IN ('unknown','low','medium','high')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_date DATE,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN (
      'unverified','single_source','verified_multi_source','therapist_confirmed','rejected'
    )),
  graphic_content_risk TEXT NOT NULL DEFAULT 'low'
    CHECK (graphic_content_risk IN ('low','medium','high')),
  child_exposure_risk TEXT NOT NULL DEFAULT 'low'
    CHECK (child_exposure_risk IN ('low','medium','high')),
  summary_for_therapists TEXT,
  do_not_show_child_text BOOLEAN NOT NULL DEFAULT true,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_events_user ON public.external_reality_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ext_events_seen ON public.external_reality_events(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ext_events_type ON public.external_reality_events(event_type);

ALTER TABLE public.external_reality_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canonical_user_can_read_ext_events"
  ON public.external_reality_events FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
CREATE POLICY "service_role_can_write_ext_events"
  ON public.external_reality_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_ext_events_updated_at
  BEFORE UPDATE ON public.external_reality_events
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();

-- 2) part_external_event_sensitivities
CREATE TABLE IF NOT EXISTS public.part_external_event_sensitivities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  part_name TEXT NOT NULL,
  event_pattern TEXT NOT NULL,
  sensitivity_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expected_reaction TEXT,
  contraindications TEXT,
  safe_opening_style TEXT,
  recommended_guard TEXT,
  last_reviewed_by TEXT,
  last_reviewed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, part_name, event_pattern)
);

CREATE INDEX IF NOT EXISTS idx_part_sens_user ON public.part_external_event_sensitivities(user_id);
CREATE INDEX IF NOT EXISTS idx_part_sens_part ON public.part_external_event_sensitivities(part_name);

ALTER TABLE public.part_external_event_sensitivities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canonical_user_can_read_part_sens"
  ON public.part_external_event_sensitivities FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
CREATE POLICY "service_role_can_write_part_sens"
  ON public.part_external_event_sensitivities FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_part_sens_updated_at
  BEFORE UPDATE ON public.part_external_event_sensitivities
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();

-- 3) external_event_impacts
CREATE TABLE IF NOT EXISTS public.external_event_impacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  event_id UUID NOT NULL REFERENCES public.external_reality_events(id) ON DELETE CASCADE,
  part_name TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'watch'
    CHECK (risk_level IN ('watch','amber','red')),
  reason TEXT,
  recommended_action TEXT,
  created_task_id UUID,
  created_briefing_id UUID,
  created_plan_patch_id UUID,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_impacts_user ON public.external_event_impacts(user_id);
CREATE INDEX IF NOT EXISTS idx_ext_impacts_event ON public.external_event_impacts(event_id);
CREATE INDEX IF NOT EXISTS idx_ext_impacts_risk ON public.external_event_impacts(risk_level);

ALTER TABLE public.external_event_impacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canonical_user_can_read_ext_impacts"
  ON public.external_event_impacts FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
CREATE POLICY "service_role_can_write_ext_impacts"
  ON public.external_event_impacts FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_ext_impacts_updated_at
  BEFORE UPDATE ON public.external_event_impacts
  FOR EACH ROW EXECUTE FUNCTION public.tdelib_set_updated_at();

-- 4) external_event_watch_runs
CREATE TABLE IF NOT EXISTS public.external_event_watch_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type TEXT NOT NULL,
  sources_checked INTEGER NOT NULL DEFAULT 0,
  new_events INTEGER NOT NULL DEFAULT 0,
  matched_events INTEGER NOT NULL DEFAULT 0,
  warnings_created INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  internet_watch_status TEXT NOT NULL DEFAULT 'not_implemented'
    CHECK (internet_watch_status IN ('implemented','partial','not_implemented')),
  notes TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_watch_runs_user ON public.external_event_watch_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_ext_watch_runs_ran ON public.external_event_watch_runs(ran_at DESC);

ALTER TABLE public.external_event_watch_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canonical_user_can_read_watch_runs"
  ON public.external_event_watch_runs FOR SELECT
  USING (auth.uid() = public.get_canonical_did_user_id() AND user_id = public.get_canonical_did_user_id());
CREATE POLICY "service_role_can_write_watch_runs"
  ON public.external_event_watch_runs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- Helper: SLO upsert RPC (used by cron + sentinel)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.did_record_slo_run(
  p_pipeline_name TEXT,
  p_status TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_evidence_ref TEXT DEFAULT NULL,
  p_next_action TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_now TIMESTAMPTZ := now();
  v_last_success TIMESTAMPTZ;
  v_last_failure TIMESTAMPTZ;
BEGIN
  IF p_status NOT IN ('ok','degraded','failed','not_implemented') THEN
    RAISE EXCEPTION 'invalid_status: %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT last_success_at, last_failure_at
    INTO v_last_success, v_last_failure
  FROM public.did_operational_slo_checks
  WHERE pipeline_name = p_pipeline_name;

  INSERT INTO public.did_operational_slo_checks (
    pipeline_name, status, last_run_at, last_success_at, last_failure_at,
    evidence, evidence_ref, next_action, staleness_minutes, updated_at
  ) VALUES (
    p_pipeline_name, p_status, v_now,
    CASE WHEN p_status = 'ok' THEN v_now ELSE v_last_success END,
    CASE WHEN p_status IN ('failed','degraded') THEN v_now ELSE v_last_failure END,
    COALESCE(p_evidence, '{}'::jsonb), p_evidence_ref, p_next_action,
    0, v_now
  )
  ON CONFLICT (pipeline_name) DO UPDATE SET
    status = EXCLUDED.status,
    last_run_at = v_now,
    last_success_at = CASE WHEN p_status = 'ok' THEN v_now ELSE public.did_operational_slo_checks.last_success_at END,
    last_failure_at = CASE WHEN p_status IN ('failed','degraded') THEN v_now ELSE public.did_operational_slo_checks.last_failure_at END,
    evidence = COALESCE(p_evidence, '{}'::jsonb),
    evidence_ref = p_evidence_ref,
    next_action = p_next_action,
    staleness_minutes = 0,
    updated_at = v_now
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ============================================================================
-- Helper: refresh staleness_minutes (cron-callable)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.did_refresh_slo_staleness()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.did_operational_slo_checks
  SET staleness_minutes = CASE
        WHEN last_run_at IS NULL THEN NULL
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - last_run_at))::INTEGER / 60)
      END,
    status = CASE
      WHEN status = 'not_implemented' THEN 'not_implemented'
      WHEN last_run_at IS NULL THEN status
      WHEN EXTRACT(EPOCH FROM (now() - last_run_at))::INTEGER / 60
           > expected_max_staleness_minutes THEN 'degraded'
      ELSE status
    END,
    updated_at = now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- ============================================================================
-- Seeds: part sensitivities (using canonical user)
-- ============================================================================
DO $$
DECLARE
  v_canonical UUID;
BEGIN
  SELECT canonical_user_id INTO v_canonical
  FROM public.did_canonical_scope
  WHERE scope_name = 'primary_did' AND active = true
  LIMIT 1;

  IF v_canonical IS NOT NULL THEN
    INSERT INTO public.part_external_event_sensitivities (
      user_id, part_name, event_pattern, sensitivity_types,
      expected_reaction, contraindications, safe_opening_style, recommended_guard
    ) VALUES
    (
      v_canonical, 'Arthur', 'Arthur Labinjo-Hughes',
      ARRAY['identity_link','child_abuse','injustice','death'],
      'Možné silné emoční zatížení, identifikace s obětí, somatické reakce, stažení.',
      'Nepotvrzovat identitu jako fakt; nepředkládat článek; žádné grafické detaily.',
      'Nízkoprahový check tělo/emoce/bezpečí; bez přímého tlaku; nabídnout jen, že dospělý ví.',
      'Karel NESMÍ potvrdit identitu části jako reálnou osobu. Pouze ověřit emoční dopad.'
    ),
    (
      v_canonical, 'Arthur', 'týrání dítěte',
      ARRAY['child_abuse','injustice'],
      'Stažení, vztek, identifikace.',
      'Žádné grafické detaily; žádné syrové texty.',
      'Stabilizace, vymezení odpovědnosti, realita vs pocit.',
      'Stop pravidlo na grafické detaily.'
    ),
    (
      v_canonical, 'Tundrupek', 'velryba',
      ARRAY['animal_suffering','rescue_failure','broken_promise'],
      'Smutek, beznaděj, narušení důvěry.',
      'Neprezentovat rescue selhání jako fakt bez ověření.',
      'Sdílení emoce, ne řešení; návrat k tělesnému bezpečí.',
      'Zaměřit na pocit, ne na faktický děj.'
    ),
    (
      v_canonical, 'Tundrupek', 'Timmy',
      ARRAY['animal_suffering','rescue_failure','broken_promise'],
      'Identifikace s konkrétním zvířetem; možný kolaps naděje.',
      'Nepřinášet aktuální zprávy o stavu Timmyho dítěti.',
      'Krátký přítomnostní check; pojmenovat pocit; nedělat závěry.',
      'Karel NESMÍ generovat informace o stavu Timmyho bez ověřeného zdroje.'
    ),
    (
      v_canonical, 'Tundrupek', 'týrání zvířat',
      ARRAY['animal_suffering','injustice'],
      'Vztek, smutek, somatické napětí.',
      'Žádné grafické detaily.',
      'Stabilizace, oddělení já-zvíře, bezpečí v přítomnosti.',
      'Stop pravidlo na grafické detaily.'
    )
    ON CONFLICT (user_id, part_name, event_pattern) DO NOTHING;
  END IF;
END;
$$;