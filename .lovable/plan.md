# P33.7C → P33.8 — STRICTLY SEQUENTIAL

**Hard rule:** P33.7C must be fully ACCEPTED (code + SQL + DOM + full vitest) before any P33.8 work begins. If P33.7C fails any acceptance flag → STOP. No P34. No parallel work. No P30/P32 modifications. No new UI features. No additional fallback banners to hide problems.

---

## PHASE 1 — P33.7C (Human Layer OK + Czech Grammar + Version Bump)

### A. Audit `human_ok=false` root cause
SQL on latest 3 P33.7 briefings for `user_id=8a7816ee-4fd1-43d4-8d83-4230d7517ae1`:
- top-level: `completeness`, `human_ok`, `renderer_version`, `errors`, `render_audit`
- per-section (limit 40): `section_id`, `title`, `confidence`, `unsupported_claims_count`, `warnings`, `karel_text`

Output table: `field | value | why_it_makes_human_ok_false | fix_needed`. Stop work here if root cause not identified.

**Flag:** `human_ok_false_root_cause_identified`

### B. Fix renderer ok-logic
Patch `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` (+ `src/lib/` mirror if exists).

`ok=true` permitted iff ALL:
- required human sections present
- `unsupported_claims_count=0`, `robotic_phrase_count=0`, `empty_sections_count=0`
- visible-text audit passes
- `daily_briefing_content_completeness.overall_status ∈ {complete, complete_with_controlled_missing}`

Never force `ok=true`. Controlled-missing alone must NOT make `ok=false` — the missing reason must be visibly rendered.

**Flags:** `complete_with_controlled_missing_allowed_for_human_ok`, `renderer_ok_not_forced`, `renderer_ok_reasonable_contract`

### C. Bump renderer + cache version
- `karel_human_briefing.renderer_version = "p33.7.1"`
- Cache gate constants in `karel-did-daily-briefing/index.ts` + mirror test file:
  - `requiredRendererVersion = "p33.7.1"`
  - `requiredCompletenessVersion = "p33.7"`
- Existing `p33.7.0` cached rows MUST be regenerated.

**Flags:** `renderer_version_bumped_to_p33_7_1`, `cache_gate_requires_p33_7_1`, `old_p33_7_0_cached_row_not_ready`

### D. Czech grammar guard for "Anička"
Renderer wording rewrite — only safe forms:
- `K části Anička`
- `K návrhu pro část Anička`
- `U Aničky` (genitive)

Forbidden: `Pro Anička`, `s Anička`, `u Anička`, `k Anička` (lowercase prep + nominative).

Update both:
- `src/lib/karelVisibleTextQuality.ts`
- `supabase/functions/_shared/karelVisibleTextQuality.ts`

Add HARD_FORBIDDEN regex (Unicode-escaped per project rule): `\b(Pro|S|s|U|u|K|k)\s+Ani[\u010d]ka\b` — but allow when preceded by `části` / `návrhu pro část`, and allow `U Aničky` (genitive form `Ani\u010dky`).

**Flags:** `bad_czech_pro_anicka_removed`, `visible_quality_blocks_bad_anicka_case`, `safe_anicka_forms_allowed`

### E. Force regenerate + SQL proof
POST to `karel-did-daily-briefing`:
```json
{"force":true,"forceRegenerate":true,"force_regenerate":true,"regenerate":true,
 "source":"p33_7c_force_regen_runtime_proof","date":"<today_prague>"}
```
Re-query latest. Required: fresh row, `is_stale=false`, `completeness_version=p33.7`, `renderer_version=p33.7.1`, `human_ok=true`, `section_count>=10`, `unsupported_claims_count=0`, `robotic_phrase_count=0`, `empty_sections_count=0`, `errors=[]`.

**Flags:** `runtime_latest_human_ok_true`, `runtime_latest_renderer_version_p33_7_1`, `runtime_latest_no_renderer_errors`

### F. DOM proof — normal Pracovna
Capture DOM/screenshot. Must show human Karel sections directly. Must NOT contain: `Humanizovaná vrstva není dostupná`, `Karlův přehled je dnes dočasně skrytý`, `002_Anička`, `Pro Anička`, `Opora v podkladech`, `doložený praktickou`, `AI polish`, `Technické podklady`, `payload`, `provider_status`, `query_plan_version`, `source_cycle_id`, `..`, old Timmi/Tundrupek primary plan.

**Flags:** `runtime_dom_human_layer_visible`, `runtime_dom_structured_fallback_not_visible`, `runtime_dom_safe_fallback_not_visible`, `runtime_dom_no_bad_czech`, `runtime_dom_no_dirty_or_debug_text`, `runtime_dom_old_timmy_not_primary`

### G. Tests — `src/test/p33_7cHumanLayerOkAndGrammar.test.tsx`
13 cases: controlled-missing→ok, blocked→not-ok, clean P33.7.1 renders in `DidDailyBriefingPanel`, ok=true hides fallback, ok=false shows fallback, dirty→safe fallback, "Pro Anička" blocked, "K části Anička" allowed, "U Aničky" allowed, Arthur/Tundrupek fixture passes, old Timmi not primary, cached p33.7.0 NOT ready, cached p33.7.1 IS ready.

**Flag:** `p33_7c_human_layer_tests_pass`

### H. `bunx vitest run --reporter=basic`
**Flag:** `full_vitest_pass`

### P33.7C verdict
ACCEPTED only if all 19 flags above true. Else `P33.7C = NOT_ACCEPTED, blocker=<flag>` and **STOP**.

---

## PHASE 2 — P33.8 (Only if P33.7C ACCEPTED)

Root cause: Karel needs an upstream daily part-workability matrix. Renderer must NOT decide workability — only display the matrix decision.

### A. Forensic source audit
Inspect every producer of `today_part_proposal | today_part_relevance_decision | proposed_session | proposed_playroom | ask_hanka | ask_kata | active_part_daily_brief | team deliberations`:
- `karel-did-daily-briefing/index.ts`
- `_shared/karelBriefingVoiceRenderer.ts`
- `_shared/todayRelevantParts.ts`
- `_shared/activePartDailyBrief.ts` (if exists)
- `_shared/dailyCyclePhaseJobs.ts`
- `_shared/dailyBriefingContentCompleteness.ts`
- `karel-did-daily-cycle/index.ts`
- `karel-did-daily-cycle-phase-worker/index.ts`
- `DidDailyBriefingPanel.tsx`
- `TeamDeliberationsPanel.tsx`

SQL: last 10 briefings + last 50 team deliberations (with `session_params` date scope and previews).

Output audit table: `source | file_or_table | field | can_create_today_part_proposal | can_create_session_plan | can_create_playroom_plan | can_create_therapist_task | uses_00_centrum | uses_part_card | uses_recent_thread | uses_live_progress | uses_yesterday_review | uses_today_date_scope | risk | needs_change`.

**Flags:** `part_selection_source_audit_complete`, `current_today_part_proposal_origin_identified`, `sources_that_ignore_00_centrum_identified`, `stale_or_dormant_part_paths_identified`

No code changes before this audit.

### B. 00_CENTRUM reader — `supabase/functions/_shared/centrumPartMatrix.ts`
`loadCentrumPartMatrix({userId,datePrague})` → `{source, read_status, rows[], warnings[]}` per spec. Drive read primary, profile fallback marked as `profile_fallback`. Missing CENTRUM ≠ inventing parts. Exclude Hana/Hanka/Hanička/Karel/Káťa. Strip `001_/002_` for display only. Respect dormant/sleeping.

**Flags:** `centrum_part_matrix_reader_exists`, `centrum_reader_used_before_today_part_selection`, `centrum_missing_is_controlled_missing`, `forbidden_non_parts_excluded_from_centrum_matrix`

### C. Workability matrix — `supabase/functions/_shared/partWorkabilityMatrix.ts`
`buildDailyPartWorkabilityMatrix(...)` returning `version: "p33.8"` with the spec'd shape.

Hard rules:
- registry-active alone ≠ primary
- dormant/sleeping requires fresh evidence (today/recent thread/live/therapist) for `possible_after_first_contact`; never auto-primary
- external reality alone → `watch_only`, never primary
- old/stale team proposal ≠ primary
- nothing qualifies → `overall_decision="no_primary_part_before_first_contact"`, `selected_primary_part=null`
- stale `002_Anička` proposal rejected
- Arthur/Tundrupek watchlist does NOT imply Anička

**Flags:** `daily_part_workability_matrix_exists`, `registry_active_alone_not_enough`, `dormant_part_not_primary_without_fresh_evidence`, `external_reality_alone_not_primary`, `old_team_proposal_not_primary`, `no_primary_part_decision_supported`

### D. Persist into briefing payload
In `karel-did-daily-briefing/index.ts`: compute matrix BEFORE renderer, write `payload.daily_part_workability_matrix`, derive `payload.today_part_relevance_decision` from matrix.

**Flags:** `payload_has_daily_part_workability_matrix`, `today_part_relevance_decision_derived_from_matrix`, `old_today_part_proposal_no_longer_source_of_truth`

### E. Renderer reads matrix
Patch "Dnešní práce s kluky" to consume `payload.daily_part_workability_matrix`:
- primary: show part + evidence + recommended route
- no-primary: first-contact / Sezení / stabilizační Herna / bezpečný kontakt + stop signs + what not to open
- watch-only: explicitly sensitivity context only

**Flags:** `renderer_uses_workability_matrix`, `renderer_no_longer_trusts_today_part_proposal_directly`, `renderer_explains_no_primary_part_decision`, `renderer_shows_evidence_for_primary_part`

### F. Session/Herna plan uses matrix
Part-named plan only if `selected_primary_part` exists or `possible_after_first_contact`. Else decision protocol; no old Timmi/Tundrupek as today plan.

**Flags:** `session_plan_uses_workability_matrix`, `playroom_plan_uses_workability_matrix`, `no_primary_part_no_specific_session_part`, `old_stale_proposals_not_primary`

### G. Therapist tasks from matrix
- Hanička: first-contact, body/emotion, stop-signal, whether part comes forward, theme awareness
- Káťa: risk/stop check, route decision, postpone-topic logic

**Flags:** `therapist_tasks_generated_from_workability_matrix`, `hanka_task_first_contact_check_present`, `kata_task_risk_stop_check_present`, `tasks_reference_watch_only_without_selecting_part`

### H. 00_CENTRUM update governance
Discovered stale/missing → review-only via `safeEnqueueDriveWrite` to label `CENTRUM_STATUS_REVIEW_QUEUE` with evidence. No direct mutation. No auto active/dormant flip.

**Flags:** `centrum_updates_review_labeled_only`, `no_direct_centrum_mutation`, `centrum_update_uses_governance`

### I. Tests — `src/test/p33_8PartWorkabilityMatrixFromCentrum.test.ts`
~16 cases per spec: registry-active alone not primary, dormant not primary, dormant+fresh→possible (not auto-primary), external-only→watch_only, old proposal not primary, approved plan supports primary, no qualifying part→no-primary decision, missing CENTRUM→blocked/controlled (not invented), Hana/Karel/Káťa excluded, stale 002_Anička rejected, Arthur/Tundrupek doesn't imply Anička, matrix derives decision, renderer uses matrix, no-primary 3 routes, tasks from matrix, centrum update review-only.

**Flag:** `p33_8_workability_matrix_tests_pass`

### J. Runtime SQL proof
Force regenerate. Verify latest payload has `daily_part_workability_matrix` (version p33.8) + derived decision + human_ok=true + renderer_version=p33.7.1.

**Flags:** `runtime_payload_has_workability_matrix`, `runtime_matrix_uses_centrum_or_controlled_missing`, `runtime_no_stale_anicka_primary`, `runtime_watch_only_not_primary`, `runtime_renderer_uses_matrix`

### K. DOM proof
Normal Pracovna shows: why-no-primary OR evidence-backed primary; if no primary 3 routes visible; no old Timmi primary; no dormant primary; watch-only labelled as sensitivity context.

**Flags:** `runtime_dom_workability_logic_visible`, `runtime_dom_no_stale_or_dormant_primary_part`, `runtime_dom_no_old_proposal_primary`

### L. `bunx vitest run --reporter=basic`
**Flag:** `full_vitest_pass`

### P33.8 verdict
ACCEPTED only if all P33.8 flags true. Else `P33.8 = NOT_ACCEPTED, blocker=<flag>`. STOP. No P34.

---

## Out of scope (do not touch)
- P30 external reality producers (read-only consumption)
- P32 Hana identity
- New UI features
- Additional fallback banners to hide issues
- P34 anything

## Files expected to change

**Phase 1 (P33.7C):**
- `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` (+ src mirror if exists) — ok-logic + version bump + Anička wording
- `supabase/functions/karel-did-daily-briefing/index.ts` — cache gate version constants
- `src/lib/karelVisibleTextQuality.ts` + `supabase/functions/_shared/karelVisibleTextQuality.ts` — Anička grammar guard
- `src/test/p33_7cHumanLayerOkAndGrammar.test.tsx` — new

**Phase 2 (P33.8) — only after Phase 1 ACCEPTED:**
- `supabase/functions/_shared/centrumPartMatrix.ts` — new
- `supabase/functions/_shared/partWorkabilityMatrix.ts` — new
- `supabase/functions/karel-did-daily-briefing/index.ts` — wire matrix into payload + derive decision
- `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` — consume matrix
- `src/test/p33_8PartWorkabilityMatrixFromCentrum.test.ts` — new
