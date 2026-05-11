# P33.7 — Daily Briefing Content Completeness & Professional Standard

This is a content-completeness task, not a text-cleanup task. Goal: Karlův přehled becomes a real morning clinical tool with mandatory sections, controlled-missing visibility, and source-backed evidence.

## Scope guardrails (do not touch)
- Do NOT modify P30 external reality producers (read-only consumption of already-produced data)
- Do NOT modify P31 AI polish
- Do NOT modify P32 Hana routing
- Do NOT add new UI features
- Do NOT start P34

## Part A — Forensic SQL audit of latest briefing
Query the latest `did_daily_briefings` row + its `karel_human_briefing.sections`. Produce a table:
`section_id | current_text_summary | data_sources_used | missing_expected_content | is_professionally_actionable | needs_change`

Answer mandatory audit questions about yesterday review, day plan, therapist tasks, external watch tiers, and old-proposal leakage.

**Acceptance:** `content_gap_audit_complete`, `all_current_missing_sections_identified`, `professional_incompleteness_confirmed`.

## Part B — Content contract (new shared module)
Create `supabase/functions/_shared/dailyBriefingContentCompleteness.ts` (and UI mirror in `src/lib/`) defining 9 required sections:
`morning_readiness | yesterday_review | today_part_or_no_part_decision | today_session_playroom_plan | therapist_tasks | external_reality_context | risk_and_stop_signals | unknowns_and_limits | next_step`

Each section yields `{section_id, status: "complete"|"controlled_missing"|"blocked", source_tables, source_fields, evidence_count, controlled_missing_reason?, visible_summary_requirement}`.

Rules: a section may be controlled_missing but must visibly state what's missing + what to do; never silently disappear.

## Part C — Yesterday review collector
In `karel-did-daily-briefing` index.ts, collect from `did_session_reviews`, `did_daily_session_plans`, `did_live_session_progress`, `did_team_deliberations` for yesterday (Prague TZ).
- If documented → render continuity block (uzavřené / otevřené / důsledek pro dnešek)
- If nothing → render explicit "Včera nemám doložené dokončené Sezení ani Hernu..."

## Part D — No-part operational fallback
When `today_part_relevance_decision.ok_for_primary_suggestion=false`, generate a structured fallback day plan with: first-contact check, safety check, three pathways (Sezení / stabilizační Herna / bezpečný kontakt), stop signs, and "what not to open today".

## Part E — Sezení / Herna plan section
Replace weak "nemám připravený plán" with structured plan state:
- Approved plan → show + source + signoff
- No approved plan → decision protocol (when Sezení vs Herna vs safe contact)
- Old proposals → only under "Starší návrhy k revizi"

## Part F — Concrete therapist tasks
Replace generic asks with source-backed concrete actions:
- **Hanička**: first-contact check, awareness of external theme, body/emotion/stop signal, route choice
- **Káťa**: risk check, stop signs, external-theme containment, postpone decision

## Part G — External reality manifestation
For each used external signal: part affected, category/trigger, recency tier, source domain, fetched/checked date, publication-date-known flag, safe language. Distinct phrasing for tier 1 / tier 2 / historical (per existing P30.5b contract).

## Part H — Payload audit field
Every payload writes `daily_briefing_content_completeness = {version: "p33.7", checked_at, sections{...9}, overall_status, blocking_reasons[]}`.
If `overall_status="blocked"` → render safe operational fallback instead of normal briefing.

## Part I — Renderer integration
Patch `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` (and UI mirror) to:
- consume `daily_briefing_content_completeness`
- render controlled-missing reasons explicitly
- include yesterday review + no-part fallback + external source manifestation
- never select dormant/low-support parts as primary

## Part J — Tests
Create `src/test/p33_7DailyBriefingContentCompleteness.test.ts` with 14+ cases covering: yesterday review (both branches), no-part fallback, decision protocol, old-proposal exclusion, concrete tasks, external tiers (1/2/3), payload completeness, blocked→fallback, dirty-phrase guard regression, dormant part exclusion.

## Part K — Force regenerate + SQL proof
Regenerate via `supabase--curl_edge_functions` against `karel-did-daily-briefing`. Re-run the audit SQL and prove every required clause visible/clean.

## Part L — DOM proof
Verify normal (non-debug) Pracovna shows the complete professional briefing with all sections, no debug, no dirty text, no stale Timmi as primary.

## Part M — Full vitest
`bunx vitest run --reporter=basic` must pass 100%.

## Final verdict
Accepted only if all 23 acceptance flags listed in the prompt are true. Otherwise emit `P33.7 = NOT_ACCEPTED, blocker=<flag>`. Stop after verdict — no P34.

---

## Technical notes

- New files: `supabase/functions/_shared/dailyBriefingContentCompleteness.ts`, `src/lib/dailyBriefingContentCompleteness.ts` (1:1 mirror), `src/test/p33_7DailyBriefingContentCompleteness.test.ts`
- Modified files: `supabase/functions/karel-did-daily-briefing/index.ts`, `supabase/functions/_shared/karelBriefingVoiceRenderer.ts`, `src/components/did/DidDailyBriefingPanel.tsx` (only to render new sections — no behavior changes beyond rendering completeness contract)
- Yesterday window: Prague TZ day boundary, `[yesterday 00:00 Europe/Prague, today 00:00)`
- Source-backed = at least one row from listed source tables for that user with valid date scope
- Controlled-missing reasons must be Czech, in Karel's voice, no debug terms
- Renderer keeps existing P33.6G visible-quality gate; new contract runs BEFORE the gate so blocked payloads short-circuit to safe fallback
