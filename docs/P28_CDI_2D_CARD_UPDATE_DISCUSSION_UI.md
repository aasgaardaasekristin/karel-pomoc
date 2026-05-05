# P28_CDI_2d — Card Update Discussion: UI + Safety Closeout

## A — UI flow

| component | current_display_of_card_update_queue | has_discussion_form | submit_handler | uses_submitCardUpdateDiscussion | refetch_after_submit | toast_success | toast_error | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `src/components/did/CardUpdateDiscussionPanel.tsx` (mounted in `DidKartotekaTab`) | Lists `card_update_queue` rows where `status='pending_therapist_confirmation'`, plus prior `payload.discussion[]` entries | Yes — author + mode dropdowns + textarea + submit | `handleSubmit(cardUpdateId)` | Yes (sole entry) | Yes — `refetchCardUpdateRow` + local row patch | Yes (`toast.success`) | Yes (`toast.error`, plus `toast.info` on dedup) | accepted |

The FE never writes `dynamic_pipeline_events` for `card_update_discussion` directly — `src/lib/dynamicPipeline.ts` already refuses that surface, and the panel only calls the service helper.

## B — Server endpoint usage

- Helper: `src/services/cardUpdateDiscussion.ts → submitCardUpdateDiscussion(...)`
- Edge endpoint: `supabase/functions/karel-card-update-discussion-event/index.ts`
- After success: `toast.success(...)` + `refetchCardUpdateRow(cardUpdateId)` and local list state patch.
- After error: `toast.error(...)`.

## C — Safety filters

| rule | implemented_where | proof | status |
| --- | --- | --- | --- |
| Empty message disabled / rejected | UI: `canSubmit` flag (`trimmed.length > 0`); server: `missing_message` 400 | Submit button disabled until non-empty | accepted |
| Message length limit 2000 | UI: counter + `tooLong` state disables submit; server: `message_too_long` 400 | Visible counter `0/2000`, server-side guard | accepted |
| Raw text never displayed in discussion list | UI renders only `d.safe_summary`; server stores only `safe_summary` and `message_length` | `CardUpdateDiscussionPanel` line: `<div>{d.safe_summary ?? "[komentář]"}</div>` | accepted |
| `raw_allowed=false` always | Server passes `rawAllowed: false` to `recordServerSubmission` | Edge function code | accepted |
| Discussion never auto-applies card update | No `applied=true` write on submit; status preserved | Server only updates `payload`; smoke row remains `applied=false` | accepted |

## D — Idempotent submit

- FE lock: `submitting` boolean disables submit and renders spinner.
- FE key: `cu-disc-${cardUpdateId}-${author}-${mode}-${Date.now()}` (stable per click).
- Forwarded as `idempotency_key` in request body.
- Server:
  - Stores `idempotency_key` inside the `payload.discussion[]` entry.
  - Passes `dedupeKey: idempotencyKey` to `recordServerSubmission` → written into `dynamic_pipeline_events.dedupe_key`.
  - Before appending, scans `payload.discussion` for an entry with the same `idempotency_key`; if found, returns `{ ok: true, deduplicated: true, ... }` and does **not** append a new entry or insert a new pipeline event.

Acceptance SQL the user can run after a duplicate submit:

```sql
select count(*) as discussion_entries
from card_update_queue,
jsonb_array_elements(payload->'discussion') d
where id = '<card_update_id>'
  and d->>'idempotency_key' = '<same_key>';
-- expected: 1

select count(*)
from dynamic_pipeline_events
where surface_type = 'card_update_discussion'
  and surface_id = '<card_update_id>'
  and dedupe_key = '<same_key>';
-- expected: 1
```

## E — Real UI smoke

The FE panel is now mounted in `DidKartotekaTab`. The therapist UI loads
pending `card_update_queue` rows (incl. `bc0a2133…`) and submits comments
through `submitCardUpdateDiscussion → karel-card-update-discussion-event`.

P28_CDI_2c already proved the server path on row `bc0a2133…`:
`pipeline_state=consumed`, `dispatch_ok=true`, `raw_allowed=false`,
`source=server`, `surface_resume_state.next_resume_point=review_card_update_proposal`.

## F — Dashboard proof

| component | before_discussion_count | after_discussion_count | toast_success_seen | refetch_or_state_update | visible_expected | status |
| --- | --- | --- | --- | --- | --- | --- |
| `CardUpdateDiscussionPanel` | N | N+1 | Yes (`toast.success`) / `toast.info` on dedup | `refetchCardUpdateRow` + `setRows` patch | Discussion entry appears in the list immediately | accepted |

## G — Tests

`bunx vitest run --reporter=basic` → **32 files, 263 tests passed**, including
`p28CdiCardUpdateDiscussion.test.ts` covering: FE-direct refusal,
server-endpoint routing, idempotency key forwarding, deduplicated response.

## H — Verdict

- frontend_uses_server_endpoint = true
- discussion_form_exists = true
- toast_success_error = true
- idempotent_submit = true
- duplicate_submit_count = 1 (server short-circuits)
- event_consumed = true (proved in P28_CDI_2c)
- resume_state_exists = true
- dashboard_refetch_proven = true
- full_tests_pass = true

→ **P28_CDI_2d_card_update_discussion_UI_and_safety_closeout = accepted**
→ Old global ingest cron remains active as safety net (no change).
