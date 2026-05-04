# P23 — Canonical Scope Blocker Repair Inventory

Generated as Part A of the P23 pass. No new features; only inventory + remediation
of unresolved P22 blockers.

## A. Write-path inventory

| edge_function | writes_table | write_kind | canonical_guard_present | where_guard_is | snapshot_required | snapshot_present | status |
|---|---|---|---|---|---|---|---|
| karel-team-deliberation-create | did_team_deliberations | insert | **false** | (none — only auth.getUser) | false (insert) | n/a | **GAP — needs P2 guard** |
| karel-team-deliberation-create | did_team_deliberations | update (race recovery, metadata) | false | none | false | n/a | minor — metadata-only |
| karel-team-deliberation-iterate | did_team_deliberations | update (program_draft, log) | true | edge `assertCanonicalDidScopeOrThrow` | true | true (`createSnapshot`) | OK |
| karel-team-deliberation-signoff | did_team_deliberations | update (signatures + sync) | true | edge guard + RPC `team_deliberation_signoff_and_sync` (P2 + P3 inside) | true | true (RPC snapshots) | OK |
| karel-team-deliberation-signoff | did_team_deliberations | update (linked_live_session_id, linked_crisis_event_id, linked_drive_write_id) | true | edge guard | true (strict) | **false** | **GAP — wrap with snapshot** |
| karel-team-deliberation-signoff | did_daily_session_plans | bridge insert/update | true | edge guard | true (for update) | bridge update is currently dead code (`false &&`); INSERT only when no plan | OK (gated; live path goes through RPC) |
| karel-daily-plan-sync-start | did_daily_session_plans, did_team_deliberations | update via RPC `sync_and_start_approved_daily_plan` | true | RPC P2 guard + P3 snapshots | true | true (RPC) | OK |
| karel-did-daily-cycle | did_daily_session_plans | update (line 7461 etc.) | partial — cron secret check, **no canonical scope assertion** | edge cron-secret only | true (update on protected table) | **false** | **GAP — needs canonical guard + snapshot** |
| karel-did-daily-briefing | did_daily_session_plans, did_team_deliberations | reads + writes briefing tables (no direct update of protected tables in scope) | partial — cron-secret OK, but `scopedUserId` falls back to "any active cycle / any thread" | edge | n/a (briefing writes its own table) | n/a | **GAP — wrong-user fallback in scope discovery** |
| karel-did-event-ingest | did_event_ingestion_log, pantry tables | insert | **false** | none — accepts body.userId on service-call without canonical match | false (insert) | n/a | **GAP — needs P2 guard** |
| karel-external-reality-sentinel | (read-mostly + side-effects) | n/a | true | edge guard | n/a | n/a | OK |
| karel-operational-coverage-check | (read-only audit) | n/a | true | edge guard | n/a | n/a | OK |
| karel-did-auto-session-plan | did_daily_session_plans | insert + update | partial — `resolveCanonicalDidUserIdOrNull` (soft) | edge | true (when updating existing plan rows) | **false** for updates at lines 262, 586, 1064 | **GAP — strict guard + snapshots for update path** |
| karel-did-apply-analysis | did_daily_session_plans | insert | partial — `resolveCanonicalDidUserIdOrNull` (soft) | edge | false (insert) | n/a | minor — soft resolver acceptable for read-anchor; needs strict on writes |

### P2 GAPS to fix
1. `karel-team-deliberation-create` — assert canonical scope before insert
2. `karel-did-event-ingest` — assert canonical scope (both auth and service paths)
3. `karel-did-daily-briefing` — replace "any cycle / any thread" fallback with `resolveCanonicalDidUserId`
4. `karel-did-daily-cycle` — assert canonical scope after cron-secret accept; canonical match for body.userId
5. `karel-did-auto-session-plan` — switch to strict `resolveCanonicalDidUserId` when proceeding to writes

### P3 GAPS to fix
1. `karel-team-deliberation-signoff` — wrap the post-bridge `linked_live_session_id`/`linked_crisis_event_id`/`linked_drive_write_id` updates with `createSnapshot` (or document as metadata-only and exempt — strict interpretation says snapshot)
2. `karel-did-daily-cycle` — wrap any direct updates to `did_daily_session_plans` (line 7461) with `createSnapshot`
3. `karel-did-auto-session-plan` — wrap updates to existing `did_daily_session_plans` rows (lines 262, 586, 1064) with `createSnapshot`

## E. Cron auth audit

Total karel-* cron jobs: 32. Using `X-Karel-Cron-Secret`: 16. Using anon/JWT bearer: **16 (need migration or justification).**

| jobid | jobname | auth_kind | action |
|---|---|---|---|
| 1 | kartoteka-daily-backup | anon_or_jwt_bearer | migrate |
| 7 | invoke-did-weekly-cycle | anon_or_jwt_bearer | migrate |
| 9 | did-monthly-cycle | anon_or_jwt_bearer | migrate |
| 10 | karel-morning-brief | anon_or_jwt_bearer | migrate |
| 25 | karel-session-plan-winter (auto-session-plan) | anon_or_jwt_bearer | migrate |
| 29 | kartoteka-update-cycle | anon_or_jwt_bearer | migrate |
| 30 | karel-shadow-sync | anon_or_jwt_bearer | migrate |
| 31 | karel-weekly-review | anon_or_jwt_bearer | migrate |
| 35 | invoke-karel-reactive-loop | anon_or_jwt_bearer | migrate |
| 37 | karel-guardian-loop-hourly | anon_or_jwt_bearer | migrate |
| 38 | analyst-loop-morning | anon_or_jwt_bearer | migrate |
| 39 | analyst-loop-afternoon | anon_or_jwt_bearer | migrate |
| 40 | karel-daily-memory-orchestrator | anon_or_jwt_bearer | migrate |
| 48 | karel-method-discovery-weekly | anon_or_jwt_bearer | migrate |
| 49 | karel-part-methods-snapshot-daily | anon_or_jwt_bearer | migrate |

(jobs already on cron-secret: 20, 21, 22, 51, 52, 54, 55, 56, 57, 58, 59, 62, 63, 64, 65, 66, 67)

## G. Historical wrong-user inventory

- `wrong_user_briefings_unquarantined` = **0** (already quarantined; column flagged elsewhere — confirm before declaring done)
- `wrong_user_cycles_unquarantined` = **46**
- Fresh non-canonical (24h): briefings = 0; cycles = 1 (jobid 38/39 analyst-loop with `00000000-0000-0000-0000-000000000000` placeholder — needs investigation, this is the analyst loop placeholder; **not** wrong-user drift, but should be marked)

## H. RPC permission

`get_canonical_did_user_id()` is `SECURITY DEFINER`. Direct authenticated SQL "permission denied" is **acceptable by design** — all production code paths call it via:
- service-role admin client in edge functions
- internal SECURITY DEFINER SQL functions (`sync_and_start_approved_daily_plan`, `team_deliberation_signoff_and_sync`)

Verdict: **service_role_only_by_design = true**. No GRANT EXECUTE TO authenticated should be added.
