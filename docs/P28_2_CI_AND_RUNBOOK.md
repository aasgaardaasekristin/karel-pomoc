# P28.2 — CI regression test + cron-secret runbook

**Status:** `P28_2_CI_and_runbook_only = accepted`
**Scope:** strictly CI/static regression + runbook. No UI monitor, no
architecture changes, no Hana / Drive / P20 / briefing / CDI changes.

## Why this exists

P28.1 fixed the root cause of sporadic 401s on
`karel-active-session-processor` (the cron command used
`current_setting('app.karel_cron_secret')`, a GUC that was never set, so
the secret header went out empty). P28.2 prevents that regression class
from coming back silently.

## Deliverables

| Gate                                              | Artifact                                                       |
|---------------------------------------------------|----------------------------------------------------------------|
| `cron_secret_regression_test_exists`              | `src/test/p28CronSecretRegression.test.ts`                     |
| `active_processor_uses_get_karel_cron_secret`     | pinned in test snapshot + verified live via DB audit           |
| `no_karel_cron_uses_current_setting_app_secret`   | DB audit + static snapshot test                                |
| `runbook_exists`                                  | `docs/RUNBOOK_CRON_SECRET_AUTH.md`                             |
| `tests_or_script_pass`                            | `bunx vitest run` green (incl. P28.1 + P28.2 contract tests)   |

## Live DB audit (captured 2026-05-05)

```sql
select count(*)
from cron.job
where command ilike '%functions/v1/karel%'
  and command ilike '%current_setting(''app.karel_cron_secret''%';
-- → 0
```

```sql
select jobname, command
from cron.job
where jobname = 'karel-active-session-processor-3min';
-- → command contains: public.get_karel_cron_secret()
```

All other `karel-*` cron jobs (33 total) resolve the secret via
`vault.decrypted_secrets` directly, which is also an approved pattern
(documented in the runbook).

## Optional live audit script

`scripts/audit-cron-secret-sources.ts` — runs the same audit against the
live DB if `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set; no-ops
otherwise so it is safe in CI without secrets.

## Acceptance

- ✅ regression test added and pinned
- ✅ runbook published
- ✅ live DB audit clean
- ✅ test suite green

→ **P28.2 = accepted.**
