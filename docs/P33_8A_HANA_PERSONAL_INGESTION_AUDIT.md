# P33.8A — Part A: Hana/osobní Ingestion Forensic Audit

Date: 2026-05-12
Owner: Karel pipeline integrity
Scope: every code path that reads, classifies, or routes Hana/osobní ("personal") thread content into the operational DID layer.

## Sources scanned

| source | file | reads_hana_personal | classifies_content_type | extracts_did_relevance | extracts_external_trigger | writes_to_drive | writes_to_part_card | writes_to_00_centrum | used_by_daily_briefing | privacy_guard | risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `karel-hana-chat` | `supabase/functions/karel-hana-chat/index.ts` | yes | partial (identity only via `hanaPersonalIdentityResolver`) | no (no semantic split) | **no** | no | no (only via downstream) | no | no | yes (response guard) | live chat path: high — speaker stays Hana, but no semantic items extracted |
| `karel-did-event-ingest` | `supabase/functions/karel-did-event-ingest/index.ts` | yes (via `runGlobalDidEventIngestion` → `collectHanaPersonal`) | partial: `classifyDidRelevance` flags `hana_personal_did_relevant` vs `personal_context_not_for_DID` only | yes for part-name / DID context tokens; **no** for nuanced themes | **no** (no `external_trigger_report` extraction, no internet lookup task) | yes (safe summary into KARTA_<part> or HANKA/SITUACNI_ANALYZA.txt) | yes (`createCardUpdateProposalIfNeeded`) | **partial** — only via 05A append, no review-queue write to 00_CENTRUM | yes (pantryB → briefing inputs) | yes (raw text never leaves origin thread) | medium — misses multi-item messages; treats whole message as one classification |
| `_shared/didEventIngestion.ts` | `supabase/functions/_shared/didEventIngestion.ts` | yes | binary (DID-relevant or not) | rough | **no** | yes | yes | partial | yes | yes | medium |
| `_shared/postChatWriteback.ts` | `supabase/functions/_shared/postChatWriteback.ts` | yes (post-chat fact mining) | content-type gating but DID-only items, not Hana semantic split | yes for facts | no | no (writes through governance for memory) | no | no | indirectly | yes | low |
| `_shared/dailyCyclePhase65MemoryCleanup.ts` | same | reads `hana_personal_memory` | n/a | n/a | no | no | no | no | n/a | yes | low |
| `karel-did-daily-briefing` | `supabase/functions/karel-did-daily-briefing/index.ts` | **no direct read** of `karel_hana_conversations`; relies on classified events surfacing into `did_pantry_packages` / `did_observations` | n/a | depends on upstream | **no** — no consumption of an external trigger lookup queue | n/a | n/a | n/a | yes (renders "Externí kontext" but only from `external_reality_events`) | n/a | high — if upstream misses item, briefing has no fallback |

## Identified gaps

1. **No semantic content split.** A single Hana message that mixes intimate guilt + DID-relevant observation + external trigger + privacy instruction is treated as **one** classification. The pilot-whale message is the canonical failure mode: DID signal present, but no external trigger lookup, no privacy instruction persistence, no household separation.
2. **No external trigger lookup pipeline from Hana reports.** `external_reality_events` only ingests from scheduled sentinel queries, not from ad-hoc topics surfaced inside Hana/osobní.
3. **No 00_CENTRUM review-queue write** when Hana brings new sensitivity for an existing part — only KARTA_<part> append happens. Workability matrix therefore cannot pick the new sensitivity up the same day.
4. **No persisted privacy instruction** ("nechci, aby to četl Artík") — guard exists at response time but is not stored as a memory rule.
5. **Daily briefing has no consumer** for an "ad-hoc external trigger lookup result" feed — even when one exists.
6. **Hana intimate vs Hana work-client vs DID-relevant** is not a typed dimension, only a binary "private vs DID-context" flag.

## Acceptance flags

- `hana_personal_ingestion_audit_complete = true`
- `did_relevant_hana_personal_gap_identified = true` (gaps 1, 3, 5)
- `privacy_gap_identified = true` (gap 4)
- `external_trigger_extraction_gap_identified = true` (gaps 2, 5)

## Decision

P33.8 (workability matrix) cannot reflect today's reality unless the upstream pipeline:

1. Splits each Hana message into typed `content_items` with privacy tier + recommended routes.
2. Persists external trigger lookups as a dedicated queue consumed by the daily briefing.
3. Mirrors privacy instructions into a stored memory rule.
4. Fans DID-relevant items into part-card review entries AND a 00_CENTRUM review-queue marker.

Implemented in Part B (`hanaPersonalSemanticClassifier.ts`) and Part D (routing).
