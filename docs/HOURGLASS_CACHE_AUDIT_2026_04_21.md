# HOURGLASS CACHE + WRITEBACK AUDIT — 2026-04-21

> Závazné rozhodnutí: **Spižírna A = composed view-model**, ne nová tabulka.
> Source-of-truth zůstává `did_daily_context.context_json` (canonical) +
> `karel_working_memory_snapshots` (derived WM) + oddělené Hana/Káťa kontexty.
> `context_cache` = jen prompt-prime cache, NIKDY runtime truth.

---

## A. TABULKA SOUČASNÝCH CACHE / SNAPSHOT / CONTEXT VRSTEV

| # | Vrstva | Soubor / tabulka / klíč | Kdo zapisuje | Kdo čte | Update / TTL | K čemu slouží | Typ | **Verdict** |
|---|---|---|---|---|---|---|---|---|
| 1 | `did_daily_context.context_json` | DB tabulka `did_daily_context` | `karel-daily-refresh` (canonical writer), `karel-did-daily-analyzer` (analysis_json), `karel-analyst-loop` | `karel-did-context-prime`, `karel-did-daily-email`, `karel-did-morning-brief`, `DidSystemOverview`, `selectCanonicalQueueFromSnapshot`, `selectCanonicalCrisesFromSnapshot` | 1× denně (Prague day) + on-demand | Canonical daily snapshot — single source of truth pro denní runtime layer | **source** | **KEEP** — je to autoritativní vrstva, držet shape lock |
| 2 | `karel_working_memory_snapshots` | DB tabulka, klíč `(user_id, snapshot_key=YYYY-MM-DD)` | `karel-wm-bootstrap` (denně) | `karel-wm-inspect`, `DidWorkingMemoryPanel` (read-only) | denně | Derived WM nad evidencí (observations/implications/profile_claims za 24h) | **derived** | **KEEP** — slouží Spižírně A jako derived layer |
| 3 | `context_cache` | DB tabulka, klíč `(user_id, function_name, cache_key)` | `karel-did-context-prime` (TTL ~30 min), `karel-hana-context-prime` (TTL 6h) | tytéž context-prime funkce | TTL → expirace, `karel-did-daily-cycle` invaliduje na konci dne | Prompt-prime cache (dlouhé harvesty drive/db, AI shrnutí) | **prompt cache** | **ISOLATE** — nesmí být čteno mimo context-prime; přidat assertion na call site |
| 4 | `did_observations` | DB tabulka | `evidencePersistence.createObservation` z `postChatWriteback`, edge funkce extrakce | `karel-wm-bootstrap`, `karel-did-context-prime`, `therapistIntelligenceFoundation` | append-only, processed flag | Surová pozorování z konverzací — zdrojová evidence pipeline | **source (B input)** | **KEEP** — vstup pro Spižírnu B |
| 5 | `did_implications` | DB tabulka | `evidencePersistence.deriveImplication`, `postChatWriteback` | `karel-did-context-prime` (recentImplications 48h), `karel-wm-bootstrap`, `therapistIntelligenceFoundation` | append-only, status/review_at | Implikace odvozené z observations — operativní závěry | **source (B output)** | **KEEP** — Spižírna B se opírá o `did_implications` + `did_observations` |
| 6 | `did_research_cache` | DB tabulka | `karel-did-research`, `karel-crisis-research` | research panely | TTL ~7 dní | Cache Perplexity rešerší — nesouvisí s daily runtime | **prompt cache** | **KEEP, isolated** — ne runtime, jen rešerše |
| 7 | `karel_memory_logs` | DB tabulka | `karel-daily-memory-orchestrator` | observability | append | Audit log paměťového cyklu | **audit** | **KEEP** — nepoužívat jako runtime cache |
| 8 | `session_memory` | DB tabulka | `extract-session-memory` | session prep, briefing | append | Stručná paměť po sezení | **source** | **KEEP** — vstup pro Spižírnu A (včerejší výsledky sezení) |
| 9 | localStorage `karel_did_daily_plan_cache_<userId>_<date>` | `src/components/did/KarelDailyPlan.tsx` | client po fetchi `karel-did-daily-cycle` | tentýž panel | per-pragueDay | UI optimistic cache pro denní plán | **client cache** | **KEEP** — UI-only, datum guard ok |
| 10 | sessionStorage `karel_briefing_return`, `karel_hub_section`, `karel_meeting_seed`, `legacy_ask_id::*` | `DidDailyBriefingPanel.tsx`, `KarelDailyPlan.tsx` | UI navigace | UI navigace | per-tab session | Navigation hand-off (nesouvisí s runtime memory) | **UI ephemeral** | **KEEP** |
| 11 | localStorage `karel_session_db_id_<sessionId>` | `SessionReportForm.tsx` | po insert do `client_sessions` | tentýž form | per-sessionId | Idempotentní create/update sessionu | **UI idempotency** | **KEEP** |
| 12 | localStorage theme keys (`THEME_STORAGE_KEY`, …) | `ThemeContext`, `ThemeEditorDialog`, `Pomoc` | uživatel | UI theming | per-user-pref | Per-section barevný preset | **UI pref** | **KEEP** |
| 13 | `partIntelligenceFoundation.excluded_scopes` (in-memory) | shared lib | n/a | partIntelligenceFoundation | per-call | Zákaz čerpat HANA_PERSONAL z `context_cache` | **guard** | **KEEP** — důkaz, že context_cache JE označen jako prompt-only |
| 14 | Drive (00_CENTRUM, PAMET_KAREL, …) | Drive | `karel-gdrive-backup`, `karel-gdocs-sync`, queue processor | `karel-did-context-prime` (operationalMemory 72h harvest) | per-write | Audit/output, ne runtime cache | **audit/output** | **KEEP** — explicitně NE runtime |

### Verdikty shrnutí

- **KEEP**: 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
- **ISOLATE**: 3 (`context_cache` — přidat varování, že NIKDO mimo context-prime z toho nesmí číst jako runtime truth)
- **REBUILD**: žádné (stávající source layery jsou v pořádku — chybí jen composer nad nimi)
- **REMOVE**: žádné

> Klíčový nález: **žádná z existujících vrstev není mrtvá**. Chybí jen
> _composed_ vrstva, která z nich poskládá ranní pracovní zásobu pro dnešek.

---

## B. CÍLOVÝ MODEL — DVĚ SPIŽÍRNY

### SPIŽÍRNA A — ranní pracovní zásoba (READ MODEL)

**Kde žije:** server-side composer `selectPantryA(sb, userId, date)` v
`supabase/functions/_shared/pantryA.ts`. Vrací typed
`PantryASnapshot`. Není to nová tabulka, je to read-model nad:

| Slot | Zdroj |
|---|---|
| `today_date` (Prague) | `pragueTodayISO()` |
| `canonical_crises` | `did_daily_context.context_json.canonical_crises` |
| `canonical_today_session` | `did_daily_context.context_json.canonical_today_session` |
| `canonical_queue` | `did_daily_context.context_json.canonical_queue` |
| `yesterday_session_results` | `session_memory` + `did_daily_context` (yesterday row) |
| `open_followups` | `did_implications` (status open/in_progress, review_at <= today+1d) |
| `today_priorities` | derivace z `canonical_queue.primary` + briefing decisions |
| `parts_status` | `karel_working_memory_snapshots.snapshot_json.parts` (yesterday daily) |
| `therapists_status` | `therapist_profiles` + `therapist_crisis_profile` |
| **`hana_personal_context`** | derivace z `karel_hana_conversations` (domain HANA/PERSONAL) — **nikdy nesmíchaný s terapeutickým** |
| **`hana_therapeutic_context`** | derivace z `karel_hana_conversations` (domain DID/THERAPEUTIC) + `therapist_profiles` (hanka) |
| `kata_therapeutic_context` | `therapist_profiles` (kata) + `therapist_crisis_profile` (kata) |
| `today_therapy_plan` | `did_daily_session_plans` (today) |
| `briefing` | `did_daily_briefings` (today, is_stale=false) |

**Důležité:** Hanička osobní vs. terapeutická jsou **dva oddělené sloty**,
nikdy jeden blob. To vynucuje typesignature `PantryASnapshot`.

### SPIŽÍRNA B — denní implikační deník (WRITE MODEL)

**Kde žije:** existující tabulky **`did_observations` + `did_implications`**
už hrají roli implikačního logu. Doplníme jen tenkou strukturní vrstvu:

- **nová tabulka `karel_pantry_b_entries`** = denní append-only deník _implikací
  vyšších úrovní_ (návrhy zápisů, follow-up potřeby, změny plánu/hypotézy),
  které nejsou prosté observations ale „co z toho plyne pro zítřek“.
- writer = `postChatWriteback` (po každém chatu) + `karel-team-deliberation-synthesize`
  + `karel-crisis-session-loop` + `karel-did-meeting`.
- reader = `karel-did-daily-cycle` ráno → flush → propsání do
  `did_implications` / `did_therapist_tasks` / `did_pending_questions`.

### Tok mezi A a B (přesýpací hodiny)

```
RÁNO (Prague 05:00 cron — karel-did-daily-cycle):
  1. flush včerejší Spižírny B
     → process karel_pantry_b_entries WHERE processed_at IS NULL
     → routovat do správných cílů (implications, tasks, questions, briefing)
     → mark processed_at = now()
  2. refill Spižírny A
     → karel-daily-refresh emits canonical did_daily_context
     → karel-wm-bootstrap emits derived WM
     → selectPantryA() bude vracet čerstvý view-model

PŘES DEN:
  - readers volají selectPantryA() (žádné raw DB resolvers)
  - writers (chat post-hook, porady, sezení) appendují do Spižírny B
  - Drive na vyžádání jen když A neobsahuje (operationalMemory 72h harvest)

PŘED DALŠÍM DNEM:
  - cron 23:50 Prague → karel-pantry-b-finalize:
    - segregate B entries by destination
    - emit final implications / followups
    - mark ready_for_morning = true
```

---

## C. INVALIDATION & WRITER/READER CONTRACT

| Vrstva | Writer | Reader | Invalidace |
|---|---|---|---|
| `did_daily_context` | `karel-daily-refresh` (canonical), `karel-did-daily-analyzer` (analysis_json) | všichni přes `composeCanonicalContext` / `selectPantryA` | denní (1 row per Prague-day) |
| `karel_working_memory_snapshots` | `karel-wm-bootstrap` | `selectPantryA` | denní (1 row per Prague-day) |
| `context_cache` (did) | `karel-did-context-prime` | TÝŽ funkce (a NIKDO jiný) | TTL 30 min + on-demand `forceRefresh` + denně end-of-day delete v `karel-did-daily-cycle` |
| `context_cache` (hana) | `karel-hana-context-prime` | TÝŽ funkce | TTL 6h |
| `karel_pantry_b_entries` | post-chat / porady / sezení | `karel-pantry-b-finalize` (cron) → `karel-did-daily-cycle` | flush daily, archive after 14d |

---

## D. CO JE OPRAVENO TÍMTO PASSEM

1. Nová `pantryA.ts` — typed composer Spižírny A (server-side view-model).
2. Nová tabulka `karel_pantry_b_entries` (append-only implikační log).
3. Nová `pantryB.ts` — helpery pro append + finalize.
4. Komentářové guardy v `context_cache` writers/readers, že je to prompt-only.
5. Frontend dál čte přes existující `selectCanonical*FromSnapshot` (žádný
   nový paralelní front-end resolver).

---

## E. CO TENTO PASS **NEDĚLÁ** (scope guard)

- Nemění UI / dashboard.
- Nepřidává nové feature.
- Neruší context-prime ani jeho cache (jen ji izoluje).
- Nestěhuje data z Drive.
- Nemění shape `did_daily_context.context_json` (zůstává v
  `canonicalSnapshot.ts` shape lock).
