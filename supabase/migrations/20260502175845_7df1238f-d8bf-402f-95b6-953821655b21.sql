CREATE OR REPLACE FUNCTION public.get_canonical_did_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_count int;
  v_user_id uuid;
begin
  select count(*), (array_agg(canonical_user_id))[1]
    into v_count, v_user_id
  from public.did_canonical_scope
  where scope_name = 'primary_did'
    and active = true
    and canonical_user_id is not null
    and seed_status = 'ready';

  if v_count = 0 then
    raise exception 'CANONICAL_USER_SCOPE_UNRESOLVED'
      using errcode = 'P0001';
  end if;
  if v_count > 1 then
    raise exception 'CANONICAL_USER_SCOPE_AMBIGUOUS'
      using errcode = 'P0001';
  end if;

  return v_user_id;
end;
$function$;