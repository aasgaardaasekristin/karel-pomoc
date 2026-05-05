# P28_CDI_2c — card_update_discussion server-side closeout

Closes the documented FE-driven gap from P28_CDI_2b for the
`card_update_discussion` surface. The therapist comment / decision flow on a
proposed `card_update_queue` row is now persisted by an edge function which
writes the dynamic pipeline event, the active activity session, and the
resume state in one server-side call. The FE pipeline helper refuses to write
`card_update_discussion` events directly.

## Server endpoint

`supabase/functions/karel-card-update-discussion-event/index.ts`

Request:

```json
{
  "card_update_id": "<uuid>",
  "message": "...",
  "author": "hanka|kata|karel",
  "mode": "discussion_comment|decision_note|request_change"
}
```

Authentication:
- JWT path → `assertCanonicalDidScopeOrThrow(admin, callingUserId)` (therapist UI).
- `X-Karel-Cron-Secret` → `verify_karel_cron_secret` + `get_canonical_did_user_id` (server-side smoke / cron).

Server work, in order:
1. Looks up the `card_update_queue` row, asserts it belongs to canonical user.
2. Appends a safe entry to `card_update_queue.payload.discussion[]`
   (`{ at, author, mode, safe_summary, message_length }`). The raw message is
   never persisted; only a length-bounded safe summary.
3. Calls `recordServerSubmission` which writes:
   - `dynamic_pipeline_events` row (`source = 'server'`, `raw_allowed = false`,
     `event_type = 'card_update_discussed'`, `surface_type = 'card_update_discussion'`).
   - `active_app_activity_sessions` upsert (`surface_type = 'card_update_discussion'`).
   - `surface_resume_state` upsert with
     `decision_status`, `last_therapist_answer`, `next_resume_point = 'review_card_update_proposal'`,
     `what_changed_since_plan = [{ change: "therapist discussed proposed card update" }]`.

## Frontend

`src/services/cardUpdateDiscussion.ts` exports `submitCardUpdateDiscussion`,
which is the only FE entry point. It POSTs to the new edge function, then
callers refetch the affected `card_update_queue` row (`refetchCardUpdateRow`)
and existing list panels (`DidKartotekaTab`, `KartothekaUpdateOrchestrator`
audit) re-read on next refresh.

`src/lib/dynamicPipeline.ts` now refuses any direct
`writeDynamicPipelineEvent` call with `surfaceType === "card_update_discussion"`
and logs a warning so any leftover FE-only paths are caught immediately.

## CARD_UPDATE_DISCUSSION_FLOW

| frontend_component | submit_handler | db_table_written | edge_function_or_rpc | server_side_event_exists | current_gap |
| --- | --- | --- | --- | --- | --- |
| `DidKartotekaTab` (review surface) | `submitCardUpdateDiscussion` | `card_update_queue.payload.discussion[]` + `dynamic_pipeline_events` + `active_app_activity_sessions` + `surface_resume_state` | `karel-card-update-discussion-event` | yes (`source=server`, `event_type=card_update_discussed`) | none |
| Other surfaces touching `card_update_queue` (e.g. `kartothekaUpdateOrchestrator`) | n/a — automated audit appends, not therapist discussion | `card_update_queue` insert | n/a | n/a (not a discussion event) | not in scope |

## CARD_UPDATE_DASHBOARD_UPDATE_PROOF

| component | submit_action | server_endpoint | db_change | dynamic_pipeline_event | resume_state | refetch_or_realtime | visible_expected_change | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DidKartotekaTab` | `submitCardUpdateDiscussion` | `karel-card-update-discussion-event` | `card_update_queue.payload.discussion[]` append | `surface_type=card_update_discussion`, `event_type=card_update_discussed`, `pipeline_state=consumed` | `decision_status`, `next_resume_point=review_card_update_proposal` | `loadData()` after submit + existing audit list `card_update_log` re-query | last discussion timestamp updates; resume row visible to processors | proven (smoke) |
| `dispatchCardUpdateDiscussion` (active processor) | resync hint | n/a | `card_update_queue.updated_at` bump | `dispatch_kind=card_update_discussion_resync_hint`, `dispatch_ok=true` | n/a | downstream UIs subscribed to `card_update_queue` updates | row reflects new updated_at | proven (smoke) |

## Smoke proof

Real row used: `bc0a2133-d487-4e38-a1cc-abdaaa91e46e` (`part_id=gustik`,
`source_thread_id=feb3bec9…`).

```
dynamic_pipeline_events
  id=57eb8185-c273-431f-b589-c2a19426429c
  surface_type=card_update_discussion
  event_type=card_update_discussed
  pipeline_state=consumed
  raw_allowed=false
  source=server
  consumed_by={dispatch_ok:true, dispatch_kind:'card_update_discussion_resync_hint'}

card_update_queue.payload.discussion[0]
  author=hanka, mode=discussion_comment
  safe_summary='[card update discussion] therapist comment added (83 chars)'

surface_resume_state
  next_resume_point=review_card_update_proposal
  decision_status=discussion_updated
```

## Acceptance gate

| criterion | status |
| --- | --- |
| `server_endpoint_exists` | ✅ `karel-card-update-discussion-event` deployed |
| `frontend_uses_server_endpoint` | ✅ `submitCardUpdateDiscussion`; FE pipeline helper refuses direct writes |
| `card_update_discussion_event_consumed` | ✅ pipeline_state=consumed, dispatch_ok=true |
| `resume_state_exists` | ✅ row written by endpoint |
| `dashboard_update_path_proven` | ✅ `payload.discussion[]` + `updated_at` bump from processor |
| `raw_allowed=false` | ✅ never set true |
| `tests_pass` | ✅ `src/test/p28CdiCardUpdateDiscussion.test.ts` (3/3) |

Old global `karel-did-event-ingest` cron is unchanged and remains the safety
net. P28_CDI_3 (reduce global cron to fallback sweeper) is **still gated** until
P28_CDI_full is fully accepted.
