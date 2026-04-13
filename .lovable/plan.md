
## FÁZE 1 — DOCUMENT GOVERNANCE (HOTOVO)

### Co bylo uděláno

#### 1. Nový soubor: `supabase/functions/_shared/documentGovernance.ts`
Centrální routing vrstva se:
- **18 content types** (profile_claim, session_result, closure_summary, closure_chronology, closure_analysis, closure_recommendations, daily_plan, next_day_plan, therapist_memory_note, situational_analysis, strategic_outlook, long_term_trajectory, dashboard_status, crisis_context, session_log, card_section_update, pattern_observation, test_result)
- **6 dokumentových vrstev** (KARTA_CASTI, 05A, 05B, 05C, DASHBOARD, PAMET_KAREL)
- Funkce `routeWrite()` — single source of truth pro routing
- Funkce `buildAuditEntry()` — generuje audit záznamy
- Funkce `isGovernedTarget()` — whitelist pro drive-queue-processor
- `REPLACE_ALLOWED_TARGETS` — rozšířeno o 05A, 05B, 05C, DASHBOARD

#### 2. Opraven: `approve-crisis-closure/index.ts` (v3)
Closure summary se nyní rozděluje:
- **Sekce E** (Chronologický log): co se stalo, průběh, trvání, trigger
- **Sekce M** (Karlova analytická poznámka): Karlův závěr, diagnostické skóre
- **Sekce D** (Terapeutická doporučení): jen doporučení pro další práci
- Každý zápis auditován přes governance vrstvu

#### 3. Opraven: `karel-drive-queue-processor/index.ts` (v2)
- Whitelist nahrazen governance `isGovernedTarget()`
- Přidány cíle: DASHBOARD, 05B, 05C
- Replace povoleno pro 05A, 05B, 05C, DASHBOARD (+ existující VLAKNA_3DNY)
- Google Docs replace používá `overwriteDoc()` místo `replaceFile()`
- Každý zápis (úspěch i chyba) auditován do `did_doc_sync_log`

#### 4. DB migrace: `did_doc_sync_log`
Přidány sloupce: `content_type`, `subject_type`, `subject_id`

#### 5. `karel-did-card-update` — beze změn
Funkce je čistý append-only writer. Žádný caller nepředává `sectionModes` (starý případ v approve-crisis-closure odstraněn). Funkce zůstává tak jak je.

#### 6. `update-part-profile` — beze změn v této fázi
Role jasně definována: autoritativní strukturální sync profilové pravdy z claims. Nespadá do denní operativy ani dashboard/paměti.

### Přesné role po Fázi 1

| Funkce | Role | Co dělá | Co NEDĚLÁ |
|--------|------|---------|-----------|
| `karel-did-card-update` | Low-level append writer | Appenduje text bloky do karty části na Drive | Nerozhoduje kam co patří, nepodporuje replace |
| `update-part-profile` | Strukturální sync | Rebuild karty z profile claims (DB → Drive) | Neřeší denní operativu, dashboard, paměť |
| `karel-drive-queue-processor` | Queue-based Drive writer | Zpracovává frontu zápisů s governance whitelistem | Nerozhoduje content type — to dělá producent |
| `approve-crisis-closure` | Closure orchestrátor | Uzavírá krize, propaguje do E/M/D | Nepíše do 05A/dashboard/paměti |
| `documentGovernance.ts` | Routing layer | Mapuje content_type → document layer | Nepíše na Drive — jen routuje a audituje |

### Co je mimo scope a patří do FÁZE 2

- Integrace governance do `karel-daily-therapist-intelligence` (writer do PAMET_KAREL)
- Integrace governance do `karel-analyst-loop` (writer do 05A, DASHBOARD)
- Integrace governance do `karel-did-daily-cycle` (writer do karet, 05A)
- Integrace governance do `karel-memory-mirror` (writer do karet)
- Denní třídění informací z vláken (co kam patří)
- Automatické routování nových content types z analýzy vláken
