# P30.3 — Query Origin Audit (Part A)

Read-only forensic audit. **No migration / code edits performed in this pass.**

## Root cause (single line)

All five hardcoded-looking daily queries are produced by a single template in
`supabase/functions/karel-external-reality-sentinel/index.ts:415`:

```ts
query: `${s.event_pattern} aktuální zpráva`
```

`internetWatchSlice` (`index.ts:380–440`) loads every active row of
`part_external_event_sensitivities` for the user, treats `event_pattern` as the
search term, appends `" aktuální zpráva"`, and pushes the result straight to
the search provider — **without** any of:

- today-relevance gate for the part
- Drive card / `did_part_profiles` read
- distinction between `query_terms`, `example_terms`, or `category_term`
- `query_enabled` / `query_policy` / `example_terms_query_enabled` review flags
- weekly per-part matrix
- `query_plan_version` / `query_source` / `trigger_source` annotation in the run payload

## Database state of `part_external_event_sensitivities`

| sensitivity_id | part_name | event_pattern | sensitivity_types | active |
|---|---|---|---|---|
| c2b07fcd-21b2-48ab-95c4-5750e9a8da0d | Arthur | `Arthur Labinjo-Hughes` | identity_link, child_abuse, injustice, death | true |
| 5d014bea-1570-4fb2-990b-1650d120f49b | Arthur | `týrání dítěte` | child_abuse, injustice | true |
| 63ae3ae2-75ee-45ca-bff6-2a698aab683f | Tundrupek | `Timmy` | animal_suffering, rescue_failure, broken_promise | true |
| b25a2fbe-63e3-4159-84b4-410221f131fd | Tundrupek | `týrání zvířat` | animal_suffering, injustice | true |
| 6307c815-5311-4326-8fc7-a91698be07ee | Tundrupek | `velryba` | animal_suffering, rescue_failure, broken_promise | true |

Existing columns: `id, user_id, part_name, event_pattern, sensitivity_types,
expected_reaction, contraindications, safe_opening_style, recommended_guard,
last_reviewed_by, last_reviewed_at, active, created_at, updated_at`.

**Missing (P30.3 must add):** `query_terms`, `negative_terms`, `example_terms`,
`query_enabled`, `example_terms_query_enabled`, `query_policy`.

## Per-query audit

| query | origin_file_or_table | origin_column_or_code_path | part_name | was_part_relevant_today | card_was_read | personal_trigger_source | sensitivity_id | sensitivity_types | event_pattern | query_terms | example_terms | is_example_term | is_category_term | is_explicit_query_term | should_be_daily_query | decision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `Arthur Labinjo-Hughes aktuální zpráva` | `karel-external-reality-sentinel/index.ts` | `index.ts:415` template `${event_pattern} aktuální zpráva` | Arthur | unknown — no gate | NO | `part_external_event_sensitivities` row only | c2b07fcd | identity_link, child_abuse, injustice, death | `Arthur Labinjo-Hughes` | (column missing) | (treated as default) | YES | NO | NO (no review-flagged explicit query term) | NO | **quarantine** |
| `týrání dítěte aktuální zpráva` | sentinel | `index.ts:415` | Arthur | unknown | NO | sensitivity row only | 5d014bea | child_abuse, injustice | `týrání dítěte` | — | — | NO | YES (child_abuse) | NO | only when Arthur is today-relevant AND has matching trigger category | **reroute_via_category** → `násilí na dětech aktuální zprávy` |
| `Timmy aktuální zpráva` | sentinel | `index.ts:415` | Tundrupek | unknown | NO | sensitivity row only | 63ae3ae2 | animal_suffering, rescue_failure, broken_promise | `Timmy` | — | (treated as default) | YES | NO | NO | NO | **quarantine** |
| `velryba aktuální zpráva` | sentinel | `index.ts:415` | Tundrupek | unknown | NO | sensitivity row only | 6307c815 | animal_suffering, rescue_failure, broken_promise | `velryba` | — | (treated as default) | YES | NO | NO | NO | **quarantine** |
| `týrání zvířat aktuální zpráva` | sentinel | `index.ts:415` | Tundrupek | unknown | NO | sensitivity row only | b25a2fbe | animal_suffering, injustice | `týrání zvířat` | — | — | NO | YES (animal_suffering) | NO | only when Tundrupek today-relevant AND has matching animal_suffering trigger category | **reroute_via_category** → `týrání zvířat aktuální zprávy` |

## Other code surfaces touching forbidden strings

- `supabase/functions/karel-acceptance-runner/index.ts:411` — filters
  `event_pattern ILIKE '%Arthur Labinjo-Hughes%'`. **Acceptance test fixture**,
  not a runtime query builder. Will be quarantined / labeled in Part J.
- `supabase/functions/karel-external-reality-sentinel/index.ts:88` — regex
  classifier `re: /Arthur Labinjo-Hughes/i` for **inbound** event tagging
  (matches news article text), not query construction. **Allowed.**
- `src/test/p9RelinkRepairContract.test.ts`, `externalRealitySentinelClassifier.test.ts`,
  `p30_1ExternalRealitySourceTruth.test.ts` — fixtures only. **Allowed.**
- `supabase/functions/_shared/externalRealitySearchProvider.ts` — thin
  Perplexity wrapper, builds no queries.
- `supabase/functions/_shared/activePartDailyBrief.ts` — reads sensitivities +
  events; does **not** filter by `query_plan_version` and is **not** linked to
  a weekly matrix yet.

## Watch run payload reality (today, Prague)

Latest 5 internet_watch runs on 2026-05-07 (UTC) all carry the identical
`payload.queries`:

```json
[
  "Arthur Labinjo-Hughes aktuální zpráva",
  "týrání dítěte aktuální zpráva",
  "velryba aktuální zpráva",
  "Timmy aktuální zpráva",
  "týrání zvířat aktuální zpráva"
]
```

`payload.query_plan` is `null`. `payload.relevant_parts`, `card_reads`,
`anchor_facts_used`, `date_risks`, `legacy_example_terms_blocked`,
`controlled_skips`, `query_plan_version` — all absent.

## Missing tables / columns

- `public.part_external_anchor_facts` — does not exist
- `public.part_external_reality_weekly_matrix` — does not exist
- `part_external_event_sensitivities` lacks: `query_terms`, `negative_terms`,
  `example_terms`, `query_enabled`, `example_terms_query_enabled`,
  `query_policy`

## Audit acceptance flags

- `current_query_origin_audit_complete = true`
- `hardcoded_or_example_query_sources_identified = true`
- `card_read_gap_identified = true`
- `weekly_matrix_gap_identified = true`

Audit complete. Proceeding to Part B (migration) under user approval.
