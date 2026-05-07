# P30.4 — `did_active_part_daily_brief` Canonicalization Audit

User: `8a7816ee-4fd1-43d4-8d83-4230d7517ae1`
Brief date: `2026-05-07` (Prague-local current date)

## Source query (read-only)

```sql
select
  id,
  part_name,
  brief_date,
  evidence_summary->>'weekly_matrix_ref' as weekly_matrix_ref,
  evidence_summary->>'query_plan_version' as query_plan_version,
  evidence_summary->>'provider_status' as provider_status,
  evidence_summary->>'excluded_from_briefing' as excluded_from_briefing,
  evidence_summary->>'exclusion_reason' as exclusion_reason,
  generated_by, generated_at, expires_at, status
from did_active_part_daily_brief
where user_id = '8a7816ee-4fd1-43d4-8d83-4230d7517ae1'
  and brief_date::date = current_date
order by part_name;
```

## Cross-reference: `part_external_reality_weekly_matrix` for today

| matrix_id | part_name |
|---|---|
| 4de5fd13-238e-4d44-8e6a-dd468f9d91e8 | 001_gerhardt |
| 8a6f6f8a-0220-4b6a-b96e-aada785fe6e7 | 002_Anička |
| b876dfed-42c8-418e-88c0-31fdea1caf3e | Arthur |
| 44058db1-415f-4c2d-ac33-1f0f9f9668a8 | gustik |
| 3ace84a4-6bf0-40dd-b0fb-0f487737d71c | Tundrupek |

These are the canonical "displayable" parts for today.

## Row-by-row classification

| id (short) | part_name | normalized_key | is_canonical_part | is_case_duplicate | is_forbidden_non_part | is_placeholder | has_weekly_matrix_ref | has_query_plan_version | presentation_safe | decision |
|---|---|---|---|---|---|---|---|---|---|---|
| d56b15cd | `001_gerhardt` | `gerhardt` | yes | no | no | no | yes | yes | **YES** | keep_displayable |
| 5ba2cf0d | `002_Anička` | `anicka` | yes | no | no | no | yes | yes | **YES** | keep_displayable |
| 111fa25a | `arthur` | `arthur` | no (alias of `Arthur`) | yes | no | no | no | yes | NO | exclude_case_duplicate |
| b1b47ec5 | `Arthur` | `arthur` | yes | no | no | no | yes | yes | **YES** | keep_displayable |
| 3abf43fb | `ARTHUR` | `arthur` | no (alias of `Arthur`) | yes | no | no | no | yes | NO | exclude_case_duplicate |
| c7556cf6 | `Dokument bez názvu` | `dokumentbeznazvu` | no | no | no | yes | no | yes | NO | exclude_placeholder |
| 53550352 | `gustik` | `gustik` | yes (canonical in matrix) | no | no | no | yes | yes | **YES** | keep_displayable |
| 836d7e7c | `GUSTIK` | `gustik` | no (alias of `gustik`) | yes | no | no | no | yes | NO | exclude_case_duplicate |
| c7463ffc | `hanička` | `hanicka` | no | no | **yes** (therapist) | no | no | no | NO | exclude_forbidden_non_part |
| 179bd985 | `karel` | `karel` | no | no | **yes** (system/agent) | no | no | no | NO | exclude_forbidden_non_part |
| af22485c | `káťa` | `kata` | no | no | **yes** (therapist) | no | no | yes | NO | exclude_forbidden_non_part |
| b1c7c9f0 | `tundrupek` | `tundrupek` | no (alias of `Tundrupek`) | yes | no | no | no | yes | NO | exclude_case_duplicate |
| 6083ced5 | `Tundrupek` | `tundrupek` | yes | no | no | no | yes | yes | **YES** | keep_displayable |
| b769dd6d | `TUNDRUPEK` | `tundrupek` | no (alias of `Tundrupek`) | yes | no | no | no | yes | NO | exclude_case_duplicate |

## Summary

- Total rows for today: **14**
- Displayable (canonical, has matrix_ref, has query_plan_version): **5**
  - `001_gerhardt`, `002_Anička`, `Arthur`, `gustik`, `Tundrupek`
- To exclude as forbidden non-part: **3** (`hanička`, `karel`, `káťa`)
- To exclude as placeholder: **1** (`Dokument bez názvu`)
- To exclude as case duplicate: **5** (`arthur`, `ARTHUR`, `GUSTIK`, `tundrupek`, `TUNDRUPEK`)
- Rows missing `weekly_matrix_ref` (subset of above invalids): **9**

All 5 weekly-matrix parts already have a corresponding canonical displayable row, so no regeneration is required (Part E will only validate, not insert).

## Acceptance flags (Part A)

- `active_part_daily_brief_bad_row_audit_complete = true`
- `legacy_duplicate_rows_identified = true`
- `forbidden_non_part_rows_identified = true`
- `placeholder_rows_identified = true`
- `matrix_ref_missing_rows_identified = true`
