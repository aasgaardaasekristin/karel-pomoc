
create or replace function public.did_get_pg_net_response(p_id bigint)
returns table(status_code int, content text, error_msg text, created timestamptz)
language sql
security definer
set search_path = public, net
as $$
  select status_code, content, error_msg, created
  from net._http_response
  where id = p_id
  limit 1
$$;

revoke all on function public.did_get_pg_net_response(bigint) from public;
grant execute on function public.did_get_pg_net_response(bigint) to service_role;
