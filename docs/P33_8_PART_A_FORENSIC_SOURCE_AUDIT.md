# P33.8 — Part A: Forensic Source Audit

Run: 2026-05-12. Read-only inspection. No code changes in this part.

## Producers / consumers map

| source | file_or_table | field | can_create_today_part_proposal | can_create_session_plan | can_create_playroom_plan | can_create_therapist_task | uses_00_centrum | uses_part_card | uses_recent_thread | uses_live_progress | uses_yesterday_review | uses_today_date_scope | risk | needs_change |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| briefing builder | `karel-did-daily-briefing/index.ts:3184–3263` | `payload.today_part_proposal`, `payload.today_part_relevance_decision` | yes | indirect (uses `proposed_session.part_name`) | indirect | no | **no** | no | no | no | yes | yes | **HIGH — proposes part purely from `proposed_session/proposed_playroom/yesterday_review`. Never consults 00_CENTRUM, registry status, watchlist, or live signals. Relevance gate called with EMPTY `recent_thread_part_names` / `live_progress_part_names` / `explicit_therapist_mentions` (lines 3256–3260) → gate is hollow.** | **YES** |
| briefing builder | `karel-did-daily-briefing/index.ts:3949–3974` | `payload.today_part_relevance_decision` (recompute) | no | no | no | no | no | no | conditional (reads tpp arrays — but they were never populated) | conditional | no | no | MEDIUM — reuses same hollow inputs. | YES |
| relevance gate (pure) | `_shared/partTodayRelevance.ts` | decision logic | no | no | no | no | no | no | input only | input only | input only | input only | OK in isolation; fed garbage by caller. | NO (kept) |
| today-relevant detector | `_shared/todayRelevantParts.ts` | `RelevantPartContext[]` | no (read) | no | no | no | **no** | no | yes (72h `did_threads`) | yes (`did_live_session_progress` 36h) | yes (via `did_today_part_proposals`) | yes | OK source detector — currently NOT called from briefing flow. | YES (wire into matrix) |
| `did_today_part_proposals` table | DB | `proposed_part`, `rationale_text` | source | — | — | — | — | — | — | — | — | yes | LOW — only `todayRelevantParts.ts` reads; nobody writes from briefing path today. | NO |
| renderer | `_shared/karelBriefingVoiceRenderer.ts:204–245` | "Dnešní práce s kluky" | reads | reads | reads | reads | no | no | no | no | no | no | **HIGH — renderer reads `today_part_proposal` directly and uses `today_part_relevance_decision` only as override; if upstream produces a flawed proposal, renderer cannot recover (matrix doesn't exist).** | **YES** |
| AI polish | `_shared/karelBriefingVoiceAiPolish.ts:207, 351` | rephrases primary part text | reads | — | — | — | no | no | no | no | no | no | MEDIUM — must consume matrix instead. | LATER (out of P33.8 minimum) |
| completeness | `_shared/dailyBriefingContentCompleteness.ts:122–157, 286` | `today_part_relevance_decision` evaluation | reads | — | — | — | no | no | no | no | no | no | MEDIUM — keys on relevance decision; OK if decision now derives from matrix. | small (read matrix-derived decision) |
| session/playroom builders | `karel-did-daily-briefing/index.ts:583, 628, 1089–1097` | `proposed_session.part_name`, `proposed_playroom.part_name` | feeds tpp | yes | yes | no | no | no | conditional (`context.recent_threads[0]`) | no | yes | yes | **HIGH — session_plan part is chosen from `yesterday_session_reviews[0]` / `yesterday_plans[0].selected_part` / `recent_threads[0]` / candidates / `proposed_playroom.part_name` — same chain that fed today_part_proposal. Bypasses CENTRUM and matrix entirely.** | **YES (gate by matrix)** |
| team deliberations | `karel-team-deliberation-create / signoff / synthesize / iterate` | `did_team_deliberations` rows | indirect (used as `usedSourceIds` only — line 3338) | feeds via `proposed_session` from review_id (line 1089) | feeds via mandatory playroom (line 1097) | no | no | no | no | no | yes (`proposed_session` from review) | yes | MEDIUM — old/stale approved deliberations can keep feeding `proposed_session.part_name` through `yesterday_session_reviews`. | YES (matrix must check freshness) |
| did_part_registry | DB (cache, mirror of 01_INDEX) | `status` (active/dormant/sleeping) | no | no | no | no | n/a (mirror of 01_INDEX which lives in 00_CENTRUM/) | no | no | no | no | no | currently UNUSED in today_part_proposal selection (`registry_sleeping: false` hardcoded line 3260). | YES (matrix must read status) |
| 01_INDEX (Drive, in `00_CENTRUM/`) | `loadDriveRegistryEntries` (`_shared/driveRegistry.ts`) | DriveRegistryEntry[] (id, primaryName, aliases, status) | no | no | no | no | **YES (canonical)** | no | no | no | no | no | OK reader exists; **currently NEVER called from briefing path.** | YES (matrix uses it) |
| entityRegistry | `_shared/entityRegistry.ts` | confirmed parts (3-tier) | no | no | no | no | yes (via 01_INDEX) | no | no | no | no | no | OK foundation — wraps Drive + DB cache. | YES (matrix uses it) |
| active_part_daily_brief | `_shared/activePartDailyBrief.ts` + `did_active_part_daily_brief` | `activity_status` (active_thread/recent_thread/watchlist/dormant) | no | no | no | no | no | no | yes | no | no | yes | OK — matrix must consume, treating `watchlist` as `watch_only` not primary. | YES (matrix consumes) |
| external_reality_watch | `karel-external-reality-*` | `payload.external_reality_watch.parts[]` | no | no | no | no | no | no | no | no | no | yes | OK — matrix must treat external reality alone as `watch_only`. | YES (matrix consumes) |

## Sources that ignore 00_CENTRUM (to be fixed)

1. `karel-did-daily-briefing/index.ts:3184–3263` — `today_part_proposal` builder
2. `karel-did-daily-briefing/index.ts:583–628, 1089–1097` — `proposed_session` / `proposed_playroom` builders
3. `karel-did-daily-briefing/index.ts:3949–3974` — relevance recompute

## Stale / dormant part paths (to be fixed)

1. `proposed_session.part_name` derived from `yesterday_session_reviews[0]` (chain at line 628) — old/approved-but-not-run plan can survive into today.
2. `proposed_playroom.part_name` carried forward from previous cycles via `injectPlayroomReviewIntoProposal` (line 859–863).
3. Old approved `did_team_deliberations` keep feeding `proposed_session` even when no fresh evidence exists.
4. `today_part_proposal` builder hardcodes `registry_sleeping: false` (line 3260) — dormant parts can become primary trivially.

## Fix direction (informs B–H, no code yet)

- **B.** New `_shared/centrumPartMatrix.ts` — wraps `loadDriveRegistryEntries` (primary) + `did_part_registry` mirror (fallback marked `profile_fallback`). Excludes Hana/Hanka/Hanička/Karel/Káťa.
- **C.** New `_shared/partWorkabilityMatrix.ts` — combines CENTRUM rows × today's signals (`detectTodayRelevantParts`, external_reality_watch, today_part_proposal, did_team_deliberations freshness) → per-part classification (`primary_candidate` / `possible_after_first_contact` / `watch_only` / `dormant_not_for_today` / `excluded`) with hard rules. Returns `version: "p33.8"`.
- **D.** Briefing edge function computes matrix BEFORE renderer; writes `payload.daily_part_workability_matrix`; derives `payload.today_part_relevance_decision` from matrix instead of from `today_part_proposal`.
- **E.** Renderer "Dnešní práce s kluky" reads matrix; primary / no-primary / watch-only branches.
- **F/G.** Session/Herna plans + therapist tasks gated by matrix (no part-named plan when `selected_primary_part === null`).
- **H.** 00_CENTRUM updates only via `safeEnqueueDriveWrite` + `CENTRUM_STATUS_REVIEW_QUEUE` label.

End of Part A.
