CREATE OR REPLACE FUNCTION public.did_p4_acceptance_inventory()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  snapshot_rpc boolean;
  rollback_rpc boolean;
  snapshots_table boolean;
  snapshots_total bigint;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'did_snapshot_protected_mutation') INTO snapshot_rpc;
  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = 'did_rollback_protected_mutation') INTO rollback_rpc;
  SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = 'public' AND c.relname = 'did_mutation_snapshots') INTO snapshots_table;
  IF snapshots_table THEN
    SELECT count(*) INTO snapshots_total FROM public.did_mutation_snapshots;
  ELSE
    snapshots_total := 0;
  END IF;
  RETURN jsonb_build_object(
    'snapshot_rpc_exists', snapshot_rpc,
    'rollback_rpc_exists', rollback_rpc,
    'snapshots_table_exists', snapshots_table,
    'snapshots_total', snapshots_total
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.did_count_visible_dirty_fields()
RETURNS bigint
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total bigint := 0;
  c1 bigint := 0;
  c2 bigint := 0;
BEGIN
  SELECT count(*) INTO c1
    FROM public.did_team_deliberations
   WHERE karel_proposed_plan ~* '(Fallback|Karel-led)';
  SELECT count(*) INTO c2
    FROM public.did_daily_session_plans
   WHERE plan_markdown ~* '(\*\*Fallback:\*\*|Karel-led)';
  total := c1 + c2;
  RETURN total;
END;
$$;

GRANT EXECUTE ON FUNCTION public.did_p4_acceptance_inventory() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.did_count_visible_dirty_fields() TO authenticated, service_role;