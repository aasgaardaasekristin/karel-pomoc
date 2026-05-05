# P28.1 — active-session-processor cron secret hardening closeout

**Status:** `P28_1_active_processor_cron_secret_retry_hardening = accepted`
**Validation started_at:** `2026-05-05T03:59:22.223326Z`
**Scope:** strictly active-session-processor auth path; no other changes.

## Root cause (re-confirmed)

The pre-fix cron command read `current_setting('app.karel_cron_secret')`, a
GUC that was never set, returning NULL. The processor therefore received an
empty `X-Karel-Cron-Secret`, which (correctly) fails verification and returns
401 — surfacing as the sporadic 401s observed in P28 final audit.

## Fix (deployed before this closeout)

- `public.get_karel_cron_secret()` — SECURITY DEFINER, reads
  `vault.decrypted_secrets`.
- Cron job `karel-active-session-processor-3min` rescheduled to use
  `public.get_karel_cron_secret()` in the request header.
- Edge handler returns explicit JSON error bodies and one retry on transient
  RPC failure (`verifyCronSecretWithRetry`).

## Part A — Validation timestamp

```
select now() as p28_1_fix_validation_started_at;
→ 2026-05-05 03:59:22.223326+00
select public.get_karel_cron_secret() is not null;  → t
```

## Part B — 5× forced canary (net.http_post + secret resolver)

Request ids 47765–47769. `net._http_response`:

| id    | status | body |
|-------|--------|------|
| 47765 | 200    | `{"ok":true,"processed_count":0,"processed":[]}` |
| 47766 | 200    | `{"ok":true,"processed_count":0,"processed":[]}` |
| 47767 | 200    | `{"ok":true,"processed_count":0,"processed":[]}` |
| 47768 | 200    | `{"ok":true,"processed_count":0,"processed":[]}` |
| 47769 | 200    | `{"ok":true,"processed_count":0,"processed":[]}` |

Edge logs aggregated where `timestamp > validation_started_at`:

| status_code | count |
|-------------|------:|
| 200         | 6 (5 canaries + 1 negative-suite preflight) |
| 401         | 2 (the two intentional negative canaries below) |
| 5xx         | 0 |

`canary_5_of_5_200 = true`, `post_fix_unexpected_401 = 0`, `post_fix_5xx = 0`.

## Part C — Cron command proof

```
jobname  = karel-active-session-processor-3min
schedule = */3 * * * *
active   = true
command  contains  public.get_karel_cron_secret()
command  does NOT contain  current_setting('app.karel_cron_secret')
```

## Part D — Explicit auth error proofs

- Missing header (req 47770) → `401`
  `{"ok":false,"error":"missing_internal_auth","has_header":false}`
- Invalid header (req 47771) → `401`
  `{"ok":false,"error":"cron_secret_verification_failed","has_header":true,"rpc_error":"secret_mismatch","retry_attempted":false}`

`retry_attempted=false` is correct: the RPC returned a deterministic
`secret_mismatch`, so no retry was warranted (retry only fires on RPC
exceptions / transient errors, per `verifyCronSecretWithRetry`).

## Part E — Service-role path

Service-role bearer path (`isService = auth === 'Bearer ' + SERVICE_KEY`)
short-circuits cron verification entirely; covered by code inspection in
`karel-active-session-processor/index.ts` and exercised by existing CDI
processor smokes.

## Part F — Tests

`src/test/p28_1ActiveProcessorAuth.test.ts` — 4 contract tests, pinning:
- valid 200 body shape,
- missing-header 401 body,
- invalid-header 401 body,
- cron command uses `public.get_karel_cron_secret()` and not the old GUC.

```
bunx vitest run src/test/p28_1ActiveProcessorAuth.test.ts
→ Test Files  1 passed (1)  Tests  4 passed (4)
```

## Part G — Final acceptance gate

| gate                                 | result |
|--------------------------------------|:------:|
| canary_5_of_5_200                    | ✅ |
| post_fix_401_count (unexpected)      | ✅ 0 |
| post_fix_5xx_count                   | ✅ 0 |
| cron_uses_get_karel_cron_secret      | ✅ |
| missing_header_error_explicit        | ✅ |
| invalid_header_error_explicit        | ✅ |
| retry_added                          | ✅ |
| tests_pass                           | ✅ |

→ **P28.1 = accepted.**
