CREATE OR REPLACE FUNCTION public.did_acceptance_run_p2p3_roundtrip(p_fixture_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_before_count bigint;
  v_after_snapshot_count bigint;
  v_after_rollback_count bigint;
  v_snapshot_id uuid;
  v_post_mutation record;
  v_post_rollback record;
BEGIN
  SELECT * INTO v_row FROM public.did_team_deliberations WHERE id = p_fixture_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'fixture_not_found';
  END IF;
  IF COALESCE((v_row.session_params->>'test_acceptance_fixture')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'refusing_to_mutate_non_fixture_row';
  END IF;

  SELECT count(*) INTO v_before_count FROM public.did_mutation_snapshots;

  v_snapshot_id := public.did_snapshot_protected_mutation(
    'did_team_deliberations', p_fixture_id,
    'P2_P3_live_proof: pre-mutation snapshot',
    'edge:acceptance-runner'
  );

  SELECT count(*) INTO v_after_snapshot_count FROM public.did_mutation_snapshots;

  -- Mutate safe fields
  UPDATE public.did_team_deliberations
     SET final_summary = 'MUTATED_VALUE_FOR_ROLLBACK_TEST',
         status = 'active'
   WHERE id = p_fixture_id;

  SELECT id, status, final_summary, initial_karel_brief
    INTO v_post_mutation
    FROM public.did_team_deliberations WHERE id = p_fixture_id;

  -- Rollback
  PERFORM public.did_rollback_protected_mutation(v_snapshot_id);

  SELECT id, status, final_summary, initial_karel_brief
    INTO v_post_rollback
    FROM public.did_team_deliberations WHERE id = p_fixture_id;

  SELECT count(*) INTO v_after_rollback_count FROM public.did_mutation_snapshots;

  RETURN jsonb_build_object(
    'snapshot_id', v_snapshot_id,
    'snapshots_before', v_before_count,
    'snapshots_after_snapshot', v_after_snapshot_count,
    'snapshots_after_rollback', v_after_rollback_count,
    'snapshot_count_increased', v_after_snapshot_count = v_before_count + 1,
    'pre_mutation_status', v_row.status,
    'pre_mutation_summary', v_row.final_summary,
    'post_mutation_status', v_post_mutation.status,
    'post_mutation_summary', v_post_mutation.final_summary,
    'post_rollback_status', v_post_rollback.status,
    'post_rollback_summary', v_post_rollback.final_summary,
    'mutation_observed', v_post_mutation.final_summary = 'MUTATED_VALUE_FOR_ROLLBACK_TEST'
                       AND v_post_mutation.status = 'active',
    'rollback_restored_summary', v_post_rollback.final_summary IS NOT DISTINCT FROM v_row.final_summary,
    'rollback_restored_status', v_post_rollback.status IS NOT DISTINCT FROM v_row.status,
    'rollback_roundtrip_passed',
        v_post_mutation.final_summary = 'MUTATED_VALUE_FOR_ROLLBACK_TEST'
        AND v_post_rollback.final_summary IS NOT DISTINCT FROM v_row.final_summary
        AND v_post_rollback.status IS NOT DISTINCT FROM v_row.status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.did_acceptance_run_p2p3_roundtrip(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.did_acceptance_run_p2p3_roundtrip(uuid) FROM PUBLIC;