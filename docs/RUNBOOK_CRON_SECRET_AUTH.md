# Runbook — cron secret auth (P28.2)

Scope: any `karel-*` edge function invoked from `cron.job` via
`net.http_post` with header `X-Karel-Cron-Secret`.

## Symptoms

- Sporadic or repeated `401` on a `karel-*` edge function.
- Edge function returns:
  - `{"ok":false,"error":"missing_internal_auth","has_header":false}` —
    cron command produced an empty header (typical when the secret source
    returns NULL).
  - `{"ok":false,"error":"cron_secret_verification_failed","has_header":true,"rpc_error":"secret_mismatch"}`
    — header was sent but did not match the stored secret.
- `function_edge_logs` shows 401s clustered on a cron schedule (e.g. every
  3 / 5 / 15 minutes).

## Inspect — edge logs

```sql
select
  m.timestamp,
  request.url,
  response.status_code,
  m.execution_time_ms
from function_edge_logs
  cross join unnest(metadata) as m
  cross join unnest(m.response) as response
  cross join unnest(m.request) as request
where request.url ilike '%/karel-active-session-processor%'
  and response.status_code = 401
order by m.timestamp desc
limit 50;
```

## Inspect — cron command

```sql
select jobid, jobname, schedule, active, command
from cron.job
where command ilike '%/karel-active-session-processor%';
```

### Correct pattern

```
'X-Karel-Cron-Secret', public.get_karel_cron_secret()
```

…or for legacy / non-P28.1 jobs the vault read is also acceptable:

```
'X-Karel-Cron-Secret',
  (select decrypted_secret from vault.decrypted_secrets
   where name = 'KAREL_CRON_SECRET' limit 1)
```

### Wrong pattern (do not use)

```
'X-Karel-Cron-Secret', current_setting('app.karel_cron_secret', true)
```

This was the P28.1 root cause: the GUC was never set, so
`current_setting(..., true)` returned NULL and the header went out empty.

## Audit — cross-job regression check

```sql
select jobname, command
from cron.job
where command ilike '%functions/v1/karel%'
  and command ilike '%current_setting(''app.karel_cron_secret''%';
-- expected: 0 rows
```

This is also enforced by:
- `src/test/p28CronSecretRegression.test.ts` (static snapshot)
- `scripts/audit-cron-secret-sources.ts` (live DB; needs service role env)

## Canary — forced 5x

```sql
do $$
declare i int; rid bigint;
begin
  for i in 1..5 loop
    select net.http_post(
      url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-active-session-processor',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'X-Karel-Cron-Secret', public.get_karel_cron_secret()
      ),
      body := jsonb_build_object('trigger','manual_canary')
    ) into rid;
    raise notice 'canary % request_id=%', i, rid;
  end loop;
end$$;
```

Then:

```sql
select id, status_code, left(content, 200) as body
from net._http_response
order by id desc
limit 7;
```

### Expected clean output

- 5 / 5 status `200`
- 0 unexpected `401`
- 0 `5xx`

## Repair / rollback

1. If a cron command still uses the GUC pattern, rewrite it via a
   migration:
   ```sql
   select cron.unschedule('<jobname>');
   select cron.schedule('<jobname>', '<schedule>', $$
     select net.http_post(
       url := '...',
       headers := jsonb_build_object(
         'Content-Type','application/json',
         'X-Karel-Cron-Secret', public.get_karel_cron_secret()
       ),
       body := '{}'::jsonb
     );
   $$);
   ```
2. If `public.get_karel_cron_secret()` returns NULL, verify the secret is
   present in the vault:
   ```sql
   select name from vault.decrypted_secrets where name = 'KAREL_CRON_SECRET';
   ```
3. Re-run the canary above and confirm 5/5 = 200 before declaring repair
   complete.

## Acceptance gates (P28.2)

- `cron_secret_regression_test_exists` — `src/test/p28CronSecretRegression.test.ts`
- `active_processor_uses_get_karel_cron_secret` — pinned in test + verified live
- `no_karel_cron_uses_current_setting_app_secret` — 0 rows from the audit query
- `runbook_exists` — this file
- `tests_or_script_pass` — `bunx vitest run` green
