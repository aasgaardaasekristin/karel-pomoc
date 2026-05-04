# P23 Phase 7 — Legacy NULL-user briefing quarantine

**Date:** 2026-05-04
**Canonical user:** `8a7816ee-4fd1-43d4-8d83-4230d7517ae1`

## Approach
- No deletion.
- No retroactive ownership reassignment.
- 46 historical `did_daily_briefings` rows with `user_id IS NULL` (pre-canonical scope era) marked stale + tagged with `payload.legacy_null_user_quarantine.active=true`.
- Full before-image of every quarantined row captured into new audit table `did_p23_null_user_quarantine_audit` (RLS on, no client access).

## Migration
`20260504205123_*.sql` — create audit table, snapshot before-images, apply quarantine markers.

## Final audit (Part E + F + G)

| metric | value |
|---|---|
| null_user_unquarantined (briefings) | **0** ✅ |
| audit_rows (before-image snapshots) | **46** ✅ |
| wrong_user_briefings_unquarantined | 0 ✅ |
| wrong_user_cycles_unquarantined | 0 ✅ |
| null_user_cycles_unquarantined | 0 ✅ |
| canonical_active_ready | 1 ✅ |

## Latest canonical briefing (Prague today)
| field | value |
|---|---|
| id | `61d12066-7177-4e62-9ae7-91a53d592450` |
| generation_method | `auto` ✅ |
| is_stale | false ✅ |
| visible_ok | true ✅ |
| p20_ok | true ✅ |
| hana_status | `used` ✅ |
| hana_count | 10 ✅ |

## Tests (Part H)
```
bunx vitest run --reporter=basic
Test Files  28 passed (28)
     Tests  248 passed (248)
```
✅

## Verdict (Part I)
- **P23 = accepted**
- **P22 = accepted_after_P23**
