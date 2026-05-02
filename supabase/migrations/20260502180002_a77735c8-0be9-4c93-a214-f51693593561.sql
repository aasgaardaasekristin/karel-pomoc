DELETE FROM public.did_team_deliberations
WHERE id = '99999999-9999-4999-8999-999999999991'::uuid;

DROP FUNCTION IF EXISTS public.did_acceptance_run_p2p3_roundtrip(uuid);
DROP TABLE IF EXISTS public.did_p2p3_acceptance_audit;