# P23 Part H — P3 Snapshot Coverage Proof

**Date:** 2026-05-04
**Status:** ✅ All destructive writes to protected tables are wrapped with `did_snapshot_protected_mutation`.

Protected tables (allowlist enforced by `did_snapshot_protected_mutation`):
- `did_team_deliberations`
- `did_daily_session_plans`

Helpers:
- TS: `supabase/functions/_shared/mutationSnapshotGuard.ts` → `snapshotProtectedMutation`, `createSnapshot`
- SQL: `public.did_snapshot_protected_mutation(p_table_name, p_row_id, p_reason, p_actor)`
- Rollback: `public.did_rollback_protected_mutation(p_snapshot_id)`

## Coverage table

| function | protected_table | write_site (line) | write_kind | snapshot_required | snapshot_present | proof_location | status |
|---|---|---|---|---|---|---|---|
| karel-team-deliberation-iterate | did_team_deliberations | index.ts:303-306 (discussion_log append) | update | yes | yes | `createSnapshot(...)` index.ts:288-294 | ✅ |
| karel-team-deliberation-iterate | did_team_deliberations | index.ts:526-536 (program_draft+session_params rewrite) | update | yes | yes | `createSnapshot(...)` index.ts:509-515 | ✅ |
| karel-team-deliberation-synthesize | did_team_deliberations | index.ts:309-316 (karel_synthesis+final_summary overwrite) | update | yes | yes | `admin.rpc("did_snapshot_protected_mutation",…)` index.ts:297-308 | ✅ |
| karel-team-deliberation-signoff | did_team_deliberations | (RPC `team_deliberation_signoff_and_sync`) | update | yes | yes (in RPC) | migration 20260502132933 lines 700, 779, 838 — `did_snapshot_protected_mutation` | ✅ covered_by_rpc |
| karel-team-deliberation-signoff | did_daily_session_plans | index.ts:399-408 (bridge update) | update | yes | yes | `snapshotProtectedMutation` index.ts:391-407 | ✅ |
| karel-team-deliberation-signoff | did_team_deliberations | index.ts:431-432 (linked_live_session_id) | update | yes | yes | `snapshotProtectedMutation` index.ts:424-437 | ✅ |
| karel-team-deliberation-signoff | did_team_deliberations | index.ts:485-486 (linked_crisis_event_id) | update | yes | yes | `snapshotProtectedMutation` index.ts:478-490 | ✅ |
| karel-team-deliberation-signoff | did_team_deliberations | index.ts:560-561 (linked_drive_write_id) | update | yes | yes | `snapshotProtectedMutation` index.ts:553-565 | ✅ |
| karel-team-deliberation-create | did_team_deliberations | inserts (no destructive update) | insert | no (insert is non-destructive) | — | grep: only `.insert(...)` | ✅ n/a |
| karel-daily-plan-sync-start | did_team_deliberations + did_daily_session_plans | (RPC `sync_and_start_approved_daily_plan`) | update | yes | yes (in RPC) | migration 20260502132933 lines 457, 580, 622 — three `did_snapshot_protected_mutation` calls before each destructive UPDATE | ✅ covered_by_rpc |
| karel-did-auto-session-plan | did_daily_session_plans | index.ts:269 (active plan rewrite) | update | yes | yes | `snapshotProtectedMutation` index.ts:263-282 | ✅ |
| karel-did-auto-session-plan | did_daily_session_plans | index.ts:614-615 (overdue_days update) | update | yes | yes | `snapshotProtectedMutation` index.ts:608-623 | ✅ |
| karel-did-auto-session-plan | did_daily_session_plans | index.ts:1102-1103 (distributed_drive update) | update | yes | yes | `snapshotProtectedMutation` index.ts:1096-1110 | ✅ |
| karel-did-daily-cycle | did_daily_session_plans | index.ts:7493 (phase_8a5 evidence_limited) | update | yes | yes | `sb.rpc("did_snapshot_protected_mutation",…)` index.ts:7483-7488 | ✅ |
| karel-did-session-finalize | did_daily_session_plans | index.ts:95 (planned_not_started safety-net) | update | yes | yes | rpc inline at index.ts:88-94 | ✅ |
| karel-did-session-finalize | did_daily_session_plans | index.ts:283 (awaiting_analysis flip) | update | yes | yes | rpc inline at index.ts:270-276 | ✅ |
| karel-did-session-finalize | did_daily_session_plans | index.ts:308 (failed_analysis flip) | update | yes | yes | rpc inline at index.ts:295-301 | ✅ |
| karel-did-session-evaluate | did_daily_session_plans | index.ts:1551 (evidence_limited overwrite) | update | yes | yes | rpc inline immediately above | ✅ |
| karel-did-session-evaluate | did_daily_session_plans | index.ts:2020 (karel_direct outcome overwrite) | update | yes | yes | rpc inline immediately above | ✅ |
| karel-did-session-evaluate | did_daily_session_plans | index.ts:2497 (post-review evaluation overwrite) | update | yes | yes | rpc inline immediately above | ✅ |
| karel-did-session-evaluate | did_daily_session_plans | index.ts:3001 (enqueueOnly pending_review) | update | yes | yes | rpc inline immediately above | ✅ |
| karel-did-playroom-evaluate | did_daily_session_plans | index.ts:423 (Herna mark done/completed) | update | yes | yes | rpc inline immediately above | ✅ |
| karel-part-session-prepare | did_daily_session_plans | index.ts:333 (deferred result_status overwrite) | update | yes | yes | rpc inline immediately above | ✅ |
| _shared/externalCurrentEventReplan | did_team_deliberations | line 568 (signature invalidation + program_draft rewrite) | update | yes | yes | `admin.rpc("did_snapshot_protected_mutation",…)` lines 558-567 | ✅ |
| karel-briefing-ask-resolve | did_team_deliberations | index.ts:252, 260 — `.select(...).maybeSingle()` only | read | no | — | grep | ✅ n/a (read-only) |
| karel-acceptance-runner | both | inventory selects only | read | no | — | grep | ✅ n/a (read-only) |
| karel-daily-refresh / karel-did-meeting / karel-did-daily-email / karel-direct-followup-process / karel-daily-dashboard / karel-operational-coverage-check / karel-guardian-loop / karel-block-followup / karel-chat / update-operative-plan / karel-crisis-closure-meeting / karel-crisis-daily-assessment (insert path) / karel-did-apply-analysis (insert path) / karel-analyst-loop / karel-team-deliberation-create / karel-crisis-session-loop / classifiedActionExecutor / crisis-retroactive-scan | both | only `.select(...)` or `.insert(...)` (no `.update(...)` or `.delete(...)` on protected tables) | read/insert | no | — | `rg "from\\(\"did_(team_deliberations\\|daily_session_plans)\"\\).*\\.(update\\|delete)"` shows no other hits | ✅ n/a |

## Verification grep

```
$ rg -n "from\(['\"]did_team_deliberations['\"]\)|from\(['\"]did_daily_session_plans['\"]\)" supabase/functions
# every line with `.update(` or `.delete(` is preceded by snapshotProtectedMutation / createSnapshot /
# admin.rpc("did_snapshot_protected_mutation", …) or routed through a SQL RPC that itself snapshots.

$ rg -n "snapshotProtectedMutation|did_snapshot_protected_mutation" supabase/functions supabase/migrations
# present in every destructive write site listed above + in SQL RPCs.
```

## Result

`p3_unprotected_destructive_updates = 0`

Remaining direct writes to `did_team_deliberations` / `did_daily_session_plans` not covered by a snapshot are **inserts only** (non-destructive) or **selects** (read-only), as confirmed by grep.
