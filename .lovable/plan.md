# P30.3 — External Reality Watch: Personal Anchor + General Trigger + Weekly Matrix

## Absolute red-line — DO NOT TURN EXAMPLES INTO QUERIES

The following strings are **examples / forbidden defaults**, never valid daily queries:

- `Arthur Labinjo-Hughes aktuální zpráva`
- `Timmy aktuální zpráva`
- `Arthur aktuální zpráva`
- `Tundrupek aktuální zpráva`
- `Gustík aktuální zpráva`
- `velryba aktuální zpráva` (when only from an `example_term`)
- any concrete case/person/animal/story name appearing only as an `example_term`

These must NOT appear in production query builder output, `external_event_watch_runs.payload.queries`, `external_event_watch_runs.payload.query_plan[].query`, `external_reality_events.raw_payload.search_query`, `did_active_part_daily_brief.evidence_summary`, or weekly matrix `query_plan[].query` — unless explicitly present as a reviewed `query_terms[]` item with `example_terms_query_enabled = true` OR `query_policy = "explicit_query_terms"`, `last_reviewed_at IS NOT NULL`, and the query_plan records `query_source = "explicit_query_terms"`.

If any forbidden example string appears as a default query after fresh runtime: **P30.3 = NOT_ACCEPTED**.

All examples in this plan are tests/fixtures only, never production query seeds.

## Scope explicitly excludes

P31, P32, P33.4, UI polish, AI polish canary, any automatic clinical write from external watch.

---

## Part A — Forensic audit (READ-ONLY)

Produce `docs/P30_3_QUERY_ORIGIN_AUDIT.md` mapping today's exact queries (`Arthur Labinjo-Hughes aktuální zpráva`, `Timmy aktuální zpráva`, `velryba aktuální zpráva`, `týrání zvířat aktuální zpráva`, `týrání dítěte aktuální zpráva`).

For each query record: query, origin_file_or_table, origin_column_or_code_path, part_name, was_part_relevant_today, card_was_read, personal_trigger_source, sensitivity_id, sensitivity_types, event_pattern, query_terms, example_terms, is_example_term, is_category_term, is_explicit_query_term, should_be_daily_query, decision (keep | quarantine | reroute_via_category | manual_review_required).

Audit paths:
- `supabase/functions/karel-external-reality-sentinel/index.ts`
- `supabase/functions/_shared/externalRealitySearchProvider.ts`
- `supabase/functions/_shared/activePartDailyBrief.ts`
- `part_external_event_sensitivities`, `external_event_watch_runs.payload.queries`, `external_reality_events.raw_payload`
- `did_active_part_daily_brief`, `did_part_registry`, `did_part_profiles`
- `CARD_PHYSICAL_MAP` / Drive card resolver
- seed/migration/test fixtures

**Acceptance flags:** `current_query_origin_audit_complete`, `hardcoded_or_example_query_sources_identified`, `card_read_gap_identified`, `weekly_matrix_gap_identified`.

**No code written until Part A done.**

> **Part A must be printed in the assistant response before any migration or code edit.**
>
> Do not silently create the audit file only. Return the audit table in the chat response AND write it to `docs/P30_3_QUERY_ORIGIN_AUDIT.md`.
>
> If Part A is incomplete: STOP. Do not run migration. Do not edit code. **P30.3 = NOT_ACCEPTED.**

---

## Part B — DB migration

1. Create `public.part_external_anchor_facts` (anchor fact cache) with unique index on `(user_id, part_name, anchor_label, fact_type, COALESCE(fact_date,'1900-01-01'), source_url)`.
2. Create `public.part_external_reality_weekly_matrix` (one row per relevant part per Prague day) with `UNIQUE(user_id, date_prague, part_name)`.
3. `ALTER TABLE part_external_event_sensitivities ADD COLUMN IF NOT EXISTS`: `query_terms jsonb`, `negative_terms jsonb`, `example_terms jsonb`, `query_enabled bool default true`, `example_terms_query_enabled bool default false`, `query_policy text default 'category_template'`, `last_reviewed_at timestamptz`, `last_reviewed_by text`.
4. RLS: canonical user reads own; service role writes; no anon writes.

**Acceptance:** anchor cache exists, weekly matrix exists, sensitivity schema distinguishes query_terms vs example_terms, `example_terms_query_enabled` defaults false.

---

## Part C — Detect today's relevant parts

`detectTodayRelevantParts({userId, datePrague, maxParts?})` in `supabase/functions/_shared/todayRelevantParts.ts`.

**Sources:** today_part_proposal, daily/session/playroom selected_part, live progress selected_part, recent threads (24–72h), explicit watchlist where `query_enabled=true`, recent active_part_daily_brief (active_thread/recent_thread/watchlist).

**Forbidden:** all `did_part_registry.status='active'` blindly; Hana/Hanka/Hanička/Karel/Káťa as parts; Tundrupek when only Arthur+Gustík relevant; Arthur when only Hana self.

Return `TodayRelevantPartContext[]` with `{part_name, source, confidence, reason}`.

**Acceptance:** detector exists, no blind registry-active, Hana/Karel excluded, runtime matches today's context.

---

## Part D — Read cards/profiles only for today's relevant parts

`loadPartPersonalTriggerProfile({userId, partName, datePrague})` in `supabase/functions/_shared/partPersonalTriggerProfile.ts`.

Source order: canonical Drive card via CARD_PHYSICAL_MAP/resolver → did_part_profiles → did_part_registry → recent active_part_daily_brief → source-backed fact cache.

Return `PartPersonalTriggerProfile` with `card_read_status` (`read_ok|profile_only|card_missing|manual_approval_required|not_mapped`), `source_refs`, `personal_triggers[]`, `biographical_anchors[]` (with `anchor_type`, `canonical_entity_name?`, `known_dates[]` w/ verification_status), `recommended_guards[]`, `controlled_skips[]`.

Rules: read card if exists; missing = controlled_skip; never send raw card text to provider; never read for irrelevant parts; concrete card names = anchors not default queries.

**Acceptance:** loader exists, reads card only for relevant, missing = controlled_skip, raw text not sent, anchor extraction exists.

---

## Part E — Source-backed anchor fact discovery + cache

`discoverAndCacheMissingPartAnchorFacts({userId, partName, profile, allowedLookupHints})` in `supabase/functions/_shared/partAnchorFactDiscovery.ts`.

Rules: never lookup by partName alone (Arthur ≠ Arthur Labinjo-Hughes; Tundrupek ≠ Timmy); requires explicit anchor hint; discovered fact must have real URL; store as `source_backed_unverified` or `pending_review`; never auto clinical-confirm.

**Card backfill:** optional, append-only, review-labeled (`SOURCE-BACKED_FACTS_TO_REVIEW`), via `safeEnqueueDriveWrite`. Hard review-mode — never auto-modify card body.

**Acceptance:** discovery exists, no lookup by part_name alone, requires source_url, cached for reuse, backfill governed and review-labeled.

---

## Part F — Date / anniversary risk

`evaluatePartAnchorDateRisk({datePrague, profile, anchorFacts, lookaheadDays?})` in `supabase/functions/_shared/partAnchorDateRisk.ts`.

Compare Prague-local date; exact day, ±3, ±7 windows; uncertain dates → "možné citlivostní okno", never "anniversary"; write into weekly matrix.

**Acceptance:** risk checker exists, anniversary detected when source-backed, uncertain not presented as fact.

---

## Part G — General daily external trigger sweep (instantiated on demand)

`buildGeneralExternalTriggerSweepQueries({datePrague, relevantParts, profiles, anchorFacts, maxQueries})` in `supabase/functions/_shared/externalRealityCategorySweep.ts`.

**Category templates instantiated only when at least one today-relevant part has a matching trigger_category** extracted from card/profile/source-backed anchor/reviewed sensitivity/weekly matrix history. Templates never run globally, never run for unrelated parts, never run just because the template exists.

Allowed templates (only when matched):
```
týrání zvířat aktuální zprávy
uvízlé zvíře záchrana aktuální zprávy
záchrana zvířete aktuální zprávy
násilí na dětech aktuální zprávy
selhání ochrany dítěte aktuální zprávy
soud týrání dítěte aktuální zprávy
katastrofa děti aktuální zprávy
```

Forbidden defaults: Timmy / Arthur Labinjo-Hughes / Arthur / Tundrupek / Gustík `aktuální zpráva`.

**Acceptance:** sweep exists, queries derived from trigger_categories, no concrete example defaults, template not run when no part has matching category.

---

## Part H — Unified dynamic query plan

`buildExternalRealityQueryPlan(...)` in `supabase/functions/_shared/externalRealityQueryPlan.ts`.

Each query: `{query, part_name, trigger_source, anchor_label?, sensitivity_id?, personal_trigger_label?, sensitivity_type?, trigger_category, query_policy, query_source, used_terms, ignored_example_terms, negative_terms, reason}`.

Rules: never use part name as query; never use example_terms by default; external anchor only if source-backed; date risk only if source-backed; dedupe by (part_name, trigger_category, normalized_query); record ignored_example_terms; controlled_skip/manual_review_required if unsafe.

**Acceptance:** combines personal+general layers; uses card triggers; uses source-backed anchors; uses date risk when source-backed; uses general sweep; never uses part_name; example_terms ignored by default; records ignored.

---

## Part I — Weekly trigger matrix

Upsert one row per relevant part per Prague day in `part_external_reality_weekly_matrix` with all fields populated (relevance source, card_read_status, personal_triggers, biographical_anchors, anchor_date_risks, sensitivity_triggers, query_plan, ignored_example_terms, external_events, source_refs, recommended_guards, provider_status).

**Acceptance:** all matrix fields populated daily.

---

## Part J — Quarantine legacy/example events

Do **not** delete. Mark legacy events `excluded_from_briefing=true`, `exclusion_reason=legacy_example_query_p30_3`, `requires_revalidation=true`. Active part daily brief ignores: `excluded_from_briefing=true`, missing/legacy `query_plan_version`, missing `source_url`, `auto_verified`.

---

## Part K — Watch run payload

Every `external_event_watch_runs.payload` includes: `query_plan_version: "p30.3_personal_anchor_general_trigger_weekly_matrix"`, `date_prague`, `relevant_parts`, `card_reads`, `anchor_facts_used`, `date_risks`, `queries`, `query_plan`, `legacy_example_terms_blocked`, `controlled_skips`.

---

## Part L — Active part daily brief + briefing output

`did_active_part_daily_brief` evidence_summary includes `provider_status`, `query_plan_version`, `trigger_source`, `weekly_matrix_ref`; arrays for `personal_triggers_today`, `biographical_anchors`, `anchor_date_risks`, `internet_triggers_today`, `source_refs`, `recommended_prevention`.

Briefing voice (`karelBriefingVoiceRenderer.ts`) speaks categories + guards + date windows, not raw counts.

**Use these examples exactly as output-shape examples, NOT as search queries:**

> U Tundrupka se dnes v externím kontextu objevily zdrojované zprávy z okruhu bezmocného nebo ohroženého zvířete. Beru to jen jako možný vnější spouštěč, ne jako diagnózu. Doporučený rámec: bez explicitních detailů, držet bezpečí, sledovat tělesnou reakci.

> U Arthura se dnes objevují zdrojované zprávy z okruhu ochrany dětí / násilí na dětech. Pracovat jen nepřímo, bez detailů, jako s možným bezpečnostním kontextem.

> U Arthura je dnes blízko zdrojovaného významného data. Beru to jako citlivostní okno, ne jako jistotu reakce.

If no events:

> Externí watch dnes pro tuto část nepřinesl relevantní zdrojovaný podklad.

**No DID observations, no card_update_queue, no KARTA writes from external watch** — anchor fact backfill only via governance, append-only, review-labeled.

---

## Part M — Tests

Create:

```
src/test/p30_3ExternalRealityPersonalAnchorAndWeeklyMatrix.test.ts
```

Do not summarize or reduce the test list. Add at least these 47 tests:

1. relevant part detector: Arthur + Tundrupek → reads exactly Arthur and Tundrupek cards.
2. relevant part detector: Gustík + Arthur → reads exactly Gustík and Arthur, not Tundrupek.
3. relevant part detector does not include all registry_active rows blindly.
4. Hana/Karel/Hanička/Káťa excluded as non-parts.
5. part card loader returns controlled_skip when card missing.
6. part card loader extracts personal_triggers.
7. part card loader extracts biographical_anchors.
8. part card loader extracts date anchors.
9. missing anchor fact discovery does not lookup by part_name alone.
10. missing anchor fact discovery requires explicit lookup hint.
11. discovered anchor fact requires source_url.
12. discovered anchor fact cached for reuse.
13. card backfill is review-labeled and uses safeEnqueueDriveWrite.
14. date risk checker detects exact source-backed anniversary.
15. date risk checker detects ±3 / ±7 window.
16. date risk checker does not assert uncertain date as fact.
17. buildExternalRealityQueryPlan does not include "Arthur Labinjo-Hughes aktuální zpráva" when it is only example_terms.
18. buildExternalRealityQueryPlan does not include "Timmy aktuální zpráva" when it is only example_terms.
19. buildExternalRealityQueryPlan does not include "Arthur aktuální zpráva" when it is only part_name or example_terms.
20. buildExternalRealityQueryPlan does not include "Tundrupek aktuální zpráva" when it is only part_name or example_terms.
21. buildExternalRealityQueryPlan does not include "Gustík aktuální zpráva" when it is only part_name or example_terms.
22. buildExternalRealityQueryPlan may include "týrání zvířat aktuální zprávy" from a matching animal_suffering / helpless_animal trigger category.
23. buildExternalRealityQueryPlan may include "násilí na dětech aktuální zprávy" from Arthur's matching personal trigger category.
24. Category template "týrání zvířat aktuální zprávy" is NOT instantiated when no today-relevant part has animal_suffering / helpless_animal / animal_rescue / animal_abuse trigger category.
25. Category template "násilí na dětech aktuální zprávy" is NOT instantiated when no today-relevant part has child_abuse / child_protection_failure trigger category.
26. query plan records trigger_source=card_personal_trigger.
27. query plan records trigger_source=biographical_anchor.
28. query plan records trigger_source=date_risk.
29. query plan records trigger_source=general_trigger_sweep.
30. query plan records ignored_example_terms.
31. query plan never uses part_name itself as query.
32. query builder deterministic for same inputs.
33. weekly matrix row created per relevant part.
34. weekly matrix contains personal_triggers.
35. weekly matrix contains biographical_anchors.
36. weekly matrix contains date_risks.
37. weekly matrix contains query_plan.
38. weekly matrix contains ignored_example_terms.
39. weekly matrix contains source_refs.
40. active_part_daily_brief excludes legacy_example_query events.
41. external watch creates no event without source_url.
42. external watch does not auto-verify events.
43. external watch does not create card_update_queue.
44. external watch does not create did_observations.
45. external watch does not create KARTA writes.
46. source audit: no hardcoded "Arthur Labinjo-Hughes aktuální zpráva" in production code outside tests/fixtures.
47. source audit: no hardcoded "Timmy aktuální zpráva" or "velryba aktuální zpráva" in production query-builder code outside tests/fixtures.

Run `bunx vitest run --reporter=basic`. Must pass.

**Acceptance:** `p30_3_query_builder_tests_pass`, `p30_3_personal_anchor_tests_pass`, `p30_3_date_risk_tests_pass`, `p30_3_weekly_matrix_tests_pass`, `full_vitest_pass` = true.

---

## Part N — Runtime proof

`docs/P30_3_RUNTIME_PROOF.md` with results from the four SQL queries (watch runs, events, active_part_daily_brief, weekly matrix, side-effect counts) for user `8a7816ee-4fd1-43d4-8d83-4230d7517ae1`.

**Date parameterization:** Use today's Prague-local date as `:today_prague`. For this run, if the current Prague date is `2026-05-07`, use `2026-05-07`. Do not hardcode the date in code or tests except runtime SQL proof. SQL: `and brief_date = '2026-05-07'` (today only) or `:today_prague`.

Verify: `query_plan_version=p30.3_personal_anchor_general_trigger_weekly_matrix`; `card_reads` exactly match relevant parts; no exact forbidden queries; concrete examples only in `ignored_example_terms`/`legacy_example_terms_blocked`; date_risk source-backed or absent; events source-backed; brief uses dynamic policy; weekly matrix populated; zero side-effect writes (card_update_queue/did_observations/KARTA pending writes from external).

---

## Part O — Final verdict

P30.3 accepted only if all acceptance flags evaluate true (full list in original brief). If anything missing: `P30.3 = NOT_ACCEPTED`.

### Additional hard fail conditions

If any of these exact strings appears in a fresh production query after P30.3:
- `Arthur Labinjo-Hughes aktuální zpráva`
- `Timmy aktuální zpráva`
- `Arthur aktuální zpráva`
- `Tundrupek aktuální zpráva`
- `Gustík aktuální zpráva`

and the query_plan does not explicitly show:
```
query_policy = "explicit_query_terms"
query_source = "explicit_query_terms"
last_reviewed_at IS NOT NULL
example_terms_query_enabled = true
```
then: **P30.3 = NOT_ACCEPTED.**

If `velryba aktuální zpráva` appears only because `Timmy` was an example term: **P30.3 = NOT_ACCEPTED.**

If `velryba / uvízlé zvíře / záchrana zvířete` appears because Tundrupek has a source-backed `animal_suffering / helpless_animal` trigger category: **allowed**, but query_plan must show the trigger category and source.

**Stop after verdict.** Do not start P31, P32, P33.4, or UI polish.

---

## Technical notes

- New shared modules under `supabase/functions/_shared/`: `todayRelevantParts.ts`, `partPersonalTriggerProfile.ts`, `partAnchorFactDiscovery.ts`, `partAnchorDateRisk.ts`, `externalRealityCategorySweep.ts`, `externalRealityQueryPlan.ts`.
- `karel-external-reality-sentinel/index.ts` `internet_watch` action refactored to: detect relevant parts → load profiles (read-only for irrelevant) → discover anchor facts (gated) → eval date risks → build query plan → run provider → persist events tagged with `query_plan_version` + `query_source` + `trigger_source` → upsert weekly matrix.
- `_shared/activePartDailyBrief.ts` refactored to filter by dynamic-policy events only and read weekly matrix.
- `karelBriefingVoiceRenderer.ts` extended to humanize categorical + date-window context (no raw counts).
- DB migration requires user approval before code changes per workflow rules.
