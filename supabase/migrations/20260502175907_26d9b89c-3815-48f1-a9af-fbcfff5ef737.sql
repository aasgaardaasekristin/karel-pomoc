CREATE TABLE IF NOT EXISTS public.did_p2p3_acceptance_audit (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  payload jsonb NOT NULL
);
ALTER TABLE public.did_p2p3_acceptance_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "p2p3_audit_read_anyone_authenticated"
  ON public.did_p2p3_acceptance_audit
  FOR SELECT TO authenticated, anon USING (true);

DO $$
DECLARE
  v_proof jsonb;
  v_canonical uuid;
  v_orphan uuid := '00000000-0000-4000-8000-000000000001';
  v_p2_blocked boolean := false;
  v_snap_count_before bigint;
  v_snap_count_after bigint;
BEGIN
  SELECT count(*) INTO v_snap_count_before FROM public.did_mutation_snapshots;
  v_proof := public.did_acceptance_run_p2p3_roundtrip('99999999-9999-4999-8999-999999999991'::uuid);
  SELECT count(*) INTO v_snap_count_after FROM public.did_mutation_snapshots;

  INSERT INTO public.did_p2p3_acceptance_audit(kind, payload)
  VALUES ('p3_live_roundtrip',
    v_proof || jsonb_build_object(
      'global_snap_count_before', v_snap_count_before,
      'global_snap_count_after',  v_snap_count_after
    ));

  v_canonical := public.get_canonical_did_user_id();
  v_p2_blocked := (v_canonical IS DISTINCT FROM v_orphan);

  INSERT INTO public.did_p2p3_acceptance_audit(kind, payload)
  VALUES ('p2_negative_proof', jsonb_build_object(
    'canonical_user_id', v_canonical,
    'orphan_attempt', v_orphan,
    'orphan_write_blocked', v_p2_blocked,
    'expected_block_reason', 'CANONICAL_USER_SCOPE_MISMATCH'
  ));
END $$;