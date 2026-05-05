
# P28_CDI_2b — Remaining surfaces, resume state, dashboard proof

Goal: extend the server-side dynamic pipeline to all remaining submission surfaces, add resume_state writes, prove dashboard refetch paths, resolve the legacy `queued=1` event, and run a safe DID part-chat smoke. The old global ingest cron stays untouched as a safety net.

Out of scope (later passes): reducing the global ingest cron, Jung persona, Hana memory, Drive lifecycle.

---

## Part A — Resolve legacy `queued_for_consumption=1`

1. Run `read_query`:
   ```sql
   select id, surface_type, surface_id, event_type, pipeline_state, consumed_by, metadata, created_at
   from dynamic_pipeline_events
   where pipeline_state='queued_for_consumption'
   order by created_at desc;
   ```
2. Decision tree:
   - If row is the failed fake-task smoke from 2a → migration UPDATE → `pipeline_state='superseded'`, `consumed_by = consumed_by || {superseded_by:'P28_CDI_2a_retry', superseded_at: now()}`.
   - If genuinely consumable → re-trigger active processor with `force_surface_id`.
   - Otherwise → report blocker.
3. Acceptance: `stale_queued_smoke_events = 0`.

## Part B — REMAINING_SURFACE_MATRIX

Produce a `docs/P28_CDI_2B_SURFACE_MATRIX.md` with one row per surface:

| surface | frontend_component | submit_handler | edge_function_or_rpc | db_table_written | server_pipeline_event_written | active_activity_session_written | resume_state_written | dashboard_refetch_or_realtime | status | gap |

Surfaces (10): `playroom_deliberation_answer`, `session_approval_answer`, `pending_question_answer`, `card_update_discussion`, `daily_plan_edit`, `live_session_block_update`, `playroom_block_update`, `did_part_chat_thread`, `session_resume`, `playroom_resume`.

Sources to inspect: `DidKidsPlayroom.tsx`, `DeliberationRoom.tsx`, `PendingQuestionsPanel.tsx`, `DidKartotekaTab.tsx`, `KarelDailyPlan.tsx`, `DidLiveSessionPanel.tsx`, `DidDailySessionPlan.tsx`, `Chat.tsx` (DID part chat), and the matching edge functions (`karel-did-playroom-evaluate`, `karel-team-deliberation-iterate`, `karel-daily-plan-sync-start`, `karel-did-card-update`, `karel-live-session-feedback`, `karel-live-session-produce`, `karel-did-chat`).

## Part C — Server-side `recordServerSubmission` for each remaining surface

For every gap found in Part B, edit the matching edge function to call `recordServerSubmission(...)` from `_shared/dynamicPipelineServer.ts` after the persisted write succeeds. Mappings:

1. **playroom_deliberation_answer** — `karel-team-deliberation-iterate` (when deliberation_type=playroom) or `karel-did-playroom-evaluate`. Event `deliberation_answered`. Resume: `last_open_question`, `last_therapist_answer`, `next_resume_point`.
2. **session_approval_answer** — `karel-daily-plan-sync-start` and the deliberation sign-off path. Event `approval_answered` (extend ServerEventType union). Resume: `approval_stage`, `last_pending_decision`, `next_resume_point`.
3. **pending_question_answer** — wherever `PendingQuestionsPanel` posts answers (likely `karel-task-feedback` or a dedicated handler — confirm via rg). Event `pending_question_answered`. Resume: `question_id`, `answered_by`, `answer_summary`.
4. **card_update_discussion** — `karel-did-card-update` / `update-part-card`. Event `card_update_discussed`. Resume: `card_update_id`, `decision_status`, `next_resume_point`.
5. **daily_plan_edit** — `karel-daily-plan-sync-start` non-start branch + plan UPDATE handlers. Event `plan_edited`. Resume: `changed_fields`, `previous_status`, `next_status`.
6. **live_session_block_update / playroom_block_update** — `karel-live-session-produce`, `karel-live-session-feedback`, `karel-block-followup`. Event `block_updated`. Resume: `current_block_index`, `last_completed_block`, `skipped_blocks`, `changed_blocks`, `reason_for_change`, `next_resume_point`, `what_changed_since_plan`.

Extend `ServerSurfaceType` and `ServerEventType` unions in `dynamicPipelineServer.ts` with `approval_answered`, `pending_question_answered`, `card_update_discussed`.

Also add corresponding dispatch branches in `karel-active-session-processor/index.ts` (mostly `updated_at` bumps so dashboards refetch; pending_question dispatches `emitPendingQuestionsChanged` realtime by bumping the row).

## Part D — DID part chat safe smoke

Add `supabase/functions/_shared/p28CdiSafeSmoke.ts` with a helper that injects a synthetic event:
```
surface_type=did_part_chat_thread
event_type=message_sent
safe_summary='[P28_CDI_2B_SMOKE] DID safe synthetic marker'
raw_allowed=false
metadata={p28_cdi_2b_smoke:true, no_child_raw_text:true}
```
Trigger `karel-active-session-processor` with `force_surface_id`. Acceptance: `dispatch_kind=did_part_chat_ingest`, `dispatch_ok=true`, `pipeline_state=consumed`.

## Part E — Resume-state proof

After Parts C+D, query:
```sql
select surface_type, surface_id, last_open_question, last_therapist_answer,
       next_resume_point, what_changed_since_plan, updated_at
from surface_resume_state
where updated_at >= now() - interval '2 hours'
order by updated_at desc;
```
Acceptance: ≥3 rows across team_deliberation_answer, playroom_deliberation_answer, and a block_update surface; `next_resume_point` non-null; `what_changed_since_plan` populated for block updates. May require a one-time migration to add the missing columns (`what_changed_since_plan`, `approval_stage`, etc.) to `surface_resume_state` if absent.

## Part F — Dashboard update proof

Build `docs/P28_CDI_2B_DASHBOARD_PROOF.md` enumerating for each remaining surface the realtime/invalidate path. Use rg over `src/components`, `src/hooks` for `invalidateQueries|refetch|reload|subscribe|postgres_changes|emitPendingQuestionsChanged`. If any panel lacks a refetch trigger, wire a `supabase.channel(...).on('postgres_changes', { table })` subscriber or invalidate the relevant React Query key.

## Part G — Forced safe smokes

Run smoke for each surface via direct insert (synthetic, `raw_allowed=false`) and force `karel-active-session-processor`. Verify:
```sql
select surface_type, event_type, pipeline_state, consumed_by, raw_allowed, metadata, created_at
from dynamic_pipeline_events
where created_at >= now() - interval '2 hours'
order by created_at desc;
```
All consumed (or explicit `skipped_safe_fixture`); `raw_allowed=false` for synthetic child/Hana surfaces.

## Part H — Cron audit (no changes)

Read-only:
```sql
select jobname, schedule, active, command from cron.job
where command ilike '%karel-did-event-ingest%' or command ilike '%karel-active-session-processor%';
```
Document `old_global_ingest_cron_kept_as_safety_net=true`, `active_processor_cron_exists=true`. **No cron edits.**

## Part I — Tests (`src/test/p28CdiRemainingSurfaces.test.ts`)

Vitest cases:
- playroom_deliberation_answer server-event dedupe key shape
- session_approval_answer event type valid in union
- pending_question_answer event type valid
- card_update_discussion event type valid
- daily_plan_edit event type valid
- live_session_block_update resume state shape (zod-style)
- did_part_chat safe synthetic event passes guards
- dashboard refetch matrix non-empty (parses the doc)
- legacy queued smoke marked superseded
- raw_allowed=false default for synthetic safe smoke

Run `bunx vitest run --reporter=basic` (auto-run by harness).

---

## Acceptance gate

```
stale_queued_smoke_events = 0
remaining_surface_matrix_complete = true
server_pipeline_events_for_remaining_surfaces = true
resume_state_count >= 3
did_part_chat_safe_smoke = pass_or_explicit_safe_skip
dashboard_update_paths_proven = true
old_global_cron_still_safety_net = true
tests_pass = true
```

If any item fails → `P28_CDI_2b = not_accepted`, report gaps. Reducing the global cron (`P28_CDI_3`) only after 2b is green.

## Files to be touched (summary)

- New migration: extend `surface_resume_state` columns; mark legacy queued event superseded.
- `supabase/functions/_shared/dynamicPipelineServer.ts` — extend unions.
- `supabase/functions/_shared/p28CdiSafeSmoke.ts` — new helper.
- `supabase/functions/karel-active-session-processor/index.ts` — dispatch branches for new surfaces.
- Edge functions: `karel-team-deliberation-iterate`, `karel-did-playroom-evaluate`, `karel-daily-plan-sync-start`, `karel-did-card-update`, `karel-live-session-produce`, `karel-live-session-feedback`, `karel-block-followup`, `karel-did-chat`, `karel-task-feedback` (pending question).
- Frontend: minimal — only add missing realtime/invalidate subscribers where Part F finds gaps.
- `docs/P28_CDI_2B_SURFACE_MATRIX.md`, `docs/P28_CDI_2B_DASHBOARD_PROOF.md`.
- `src/test/p28CdiRemainingSurfaces.test.ts`.
