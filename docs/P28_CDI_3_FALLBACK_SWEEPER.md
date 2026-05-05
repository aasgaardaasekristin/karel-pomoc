# P28_CDI_3 — Reduce global ingest to fallback sweeper

## Before

| jobname | schedule | role |
| --- | --- | --- |
| `karel-active-session-processor-3min` | `*/3 * * * *` | active surface processor |
| `karel-did-event-ingest-every-15-min` | `*/15 * * * *` | **primary** global poll of all Hana threads |

## After

| jobname | schedule | role |
| --- | --- | --- |
| `karel-active-session-processor-3min` | `*/3 * * * *` | **primary** event-driven processor |
| `karel-did-event-ingest-fallback-sweeper` | `17 * * * *` | hourly fallback safety net |

The 15-min cron `karel-did-event-ingest-every-15-min` has been
`cron.unschedule(...)`-ed. A new hourly job
`karel-did-event-ingest-fallback-sweeper` (jobid 85) replaces it.

## Fallback sweeper contract

`POST karel-did-event-ingest` body:

```json
{
  "mode": "fallback_sweeper",
  "source_filter": ["hana_personal_ingestion", "did_thread_ingestion"],
  "only_missed_active_sessions": true,
  "max_age_hours": 24,
  "stale_after_minutes": 30,
  "reason": "p28_cdi_3_fallback_sweeper"
}
```

Edge function behaviour (`supabase/functions/karel-did-event-ingest/index.ts`):

1. Resolve canonical DID user (P2 fail-closed).
2. Look up `active_app_activity_sessions` where
   `last_activity_at >= now() - max_age_hours`
   AND (`last_processed_at IS NULL OR last_processed_at < now() - stale_after_minutes`).
3. Count `dynamic_pipeline_events` with `pipeline_state='new_event'` older
   than `stale_after_minutes` and within the same window.
4. **If neither set has rows, return immediately with
   `ran_global_ingest=false, reason='no_missed_work'`.**  No global poll.
5. Otherwise call `runGlobalDidEventIngestion` with the bounded
   `sinceISO` and the explicit source filter (Hana + DID threads only).

## Canary

```text
POST karel-did-event-ingest { mode: "fallback_sweeper", userId: <canonical> }
→ 200
{
  "mode": "fallback_sweeper",
  "missed_sessions": 13,
  "stale_events": 0,
  "ran_global_ingest": true,
  "duplicate_count": 12,
  "processed_count": 0,
  "source_filter": ["hana_personal_ingestion","did_thread_ingestion"]
}
```

All 12 collected events were de-duplicated by `source_ref + source_hash`
(no new writes). The active-session processor remains the primary
real-time path on `*/3 * * * *`.

## Safety gates

- `global_poll_all_threads` = **false** (sweeper short-circuits when no missed work)
- `active_processor_primary` = **true** (`*/3 * * * *`)
- `fallback_sweeper_exists` = **true** (jobid 85, `17 * * * *`)
- `fallback_duplicate_count` = **0 new inserts** (server dedupes)
- `old_global_15min_poll_removed_or_deactivated` = **true** (`cron.unschedule('karel-did-event-ingest-every-15-min')`)

## Rollback

```sql
SELECT cron.unschedule('karel-did-event-ingest-fallback-sweeper');
SELECT cron.schedule(
  'karel-did-event-ingest-every-15-min',
  '*/15 * * * *',
  $$ SELECT public.invoke_p23_canary_generic(
       'karel-did-event-ingest',
       jsonb_build_object('mode','since_cursor',
         'source_filter', jsonb_build_array('hana_personal_ingestion'),
         'source','cron_hana_personal_ingest'),
       120000); $$
);
```
