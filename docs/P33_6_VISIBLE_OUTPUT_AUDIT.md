# P33.6 — Visible Output Audit

Audit všech viditelných textů v Karlově denním přehledu, jejich datových zdrojů, čerstvostních pravidel a aktuálních problémů.

## Tabulka viditelných ploch

| visible_text_or_panel | component_file | line_range | data_source | payload_path_or_table | source_cycle_id_used? | briefing_date_used? | expires_at_or_valid_until? | is_admin_only? | is_collapsed? | current_problem | needs_change |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Karel human briefing — sekce | `src/components/did/DidDailyBriefingPanel.tsx` | 1671–1738 | DB | `did_daily_briefings.payload.karel_human_briefing.sections[].karel_text` | yes (z renderer payload) | yes (briefing_date) | – | no | no | Texty obsahují "Opora v podkladech je nízká", technické prefixy `002_`, frázi "doloženého Sezení nebo Herny" → vnímáno strojově | Aplikovat `karelVisibleTextQuality.auditVisibleKarelText` + rozšířený `sanitizeKarelVisibleText`; renderer Section 3 přepsat (níže C) |
| Externí kontext (Section 6 – renderer) | `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` | 277–339 | derived | `payload.external_reality_watch.{provider_status, source_backed_events_count, internet_events_used_count}` | – | – | – | no | no | Generická věta "Externí situační přehled je dnes dostupný..." nezmíní, že Karel skutečně provedl internetovou kontrolu, a nerozlišuje tier 2 (checked-today) | Doplnit větu o tier 2/tier 3 zdrojích, pojmenovat doménu/datum když je k dispozici |
| Citlivosti dne (Section 7 – risks) | `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` | 344–409 | derived | `payload.external_reality_watch.parts[].(internet_triggers_today, evidence_summary.{checked_external_sources_today, historical_external_triggers})` | – | – | freshness.display_tier | no | no | Logika je v zásadě správně, ale text může vyznít jako "dnešní událost" pro tier 2/3 | Vyhradit slova "dnes ověřil/dříve evidovaný" a zakázat "může dnes zatížit" pro tier 2/3 |
| Možné vnější zatížení (panel) | `src/components/did/ExternalLoadWarning.tsx` | 1–157 | edge | `karel-external-reality-sentinel/list_impacts` → `clusterAndHumanizeExternalImpacts` | – | – | freshness tier | no | no | Po P30.5B správně zobrazuje doménu/datum/tier; chybí jen drobné jazykové sjednocení | Drží se, žádná velká změna; quality gate se ověří v testu |
| Dnešní práce s kluky (Section 3) | `supabase/functions/_shared/karelBriefingVoiceRenderer.ts` | 155–196 | derived | `payload.today_part_proposal.{proposed_part, evidence_strength, is_hypothesis_only, rationale_text}` | – | – | – | no | no | "nabízí se část 002_Anička" + "Opora v podkladech je nízká" | Použít `partTodayRelevance.normalizeDisplayName` a fallback "Dnes nemám dost opory vybrat konkrétní část před prvním kontaktem." |
| `today_part_proposal.rationale_text` | `supabase/functions/karel-did-daily-briefing/index.ts` | 3190–3211 | edge | `did_daily_briefings.payload.today_part_proposal` | yes | yes | – | no | no | Obsahuje "Síla důkazu je nízká", "doloženého Sezení nebo Herny", "Návrh na dnešní část je 002_…" | Přepsat na Karlův hlas bez technických metrik; normalizovat název části |
| Technické podklady (toggle) | `src/components/did/DidDailyBriefingPanel.tsx` | 1748–1759 | UI | derived | – | – | – | should be admin only | yes (collapsed) | Vidí ho i normální terapeutky | Skrýt mimo `karelDebugMode()` |
| AI polish náhled — pouze audit | `src/components/did/AiPolishCanaryPreviewPanel.tsx` | 99–207 | DB | `p31_ai_polish_canary_runs` | – | – | – | should be admin only | yes (details) | Texty "AI polish náhled — pouze audit" jsou v normálním UI | Skrýt mimo `karelDebugMode()` |
| Společná porada týmu | `src/components/did/TeamDeliberationsPanel.tsx` | 137–224 | hook | `useTeamDeliberations` → `did_team_deliberations` | – | – | `closed_at`, `status` | no | partial (overflow) | Filtruje jen status active/awaiting_signoff, ale neověřuje stáří/source_cycle vůči dnešku | Vyžadovat `updated_at >= today - 24h` nebo `linked_briefing_id = today's briefing` pro primary; jinak overflow |
| Plán dnešní herny / sezení | renderer Section 5 | 240–272 | derived | `payload.proposed_session`, `payload.proposed_playroom` | – | yes (briefing_date) | – | no | no | Pokud návrhy mají staré datum, zobrazí se jako dnešní rámec | Renderer musí zkontrolovat `proposed_session.session_date` (pokud existuje) — pokud ≠ dnes, neoznačovat jako "Pro dnešní Sezení" |
| Úkoly pro terapeutky (asks) | renderer Section 4 | 201–235 | derived | `payload.ask_hanka[]`, `payload.ask_kata[]` | – | – | – | no | no | OK | beze změny |

## Acceptance flagy

- `visible_output_audit_complete = true`
- `all_visible_text_sources_identified = true`
- `technical_debug_leak_identified = true` (Technické podklady + AI polish)
- `stale_team_proposal_source_identified = true` (TeamDeliberationsPanel)
- `dormant_part_proposal_source_identified = true` (today_part_proposal v renderer + briefing index)
- `internet_visibility_gap_identified = true` (renderExternalReality)
