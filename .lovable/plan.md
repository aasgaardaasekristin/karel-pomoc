
# Přepracování „Plán dnešní herny" — klinický decision surface

Toto je velký scope. Jasně si rozdělíme co dělám, co vědomě **nedělám teď**, a co potřebuje další iteraci. Bez tvého souhlasu na rozsahu nic nepíšu.

## Co je potvrzená pravda dnes (z kódu + DB)

- DB řádek `did_daily_session_plans` pro Tundrupka dnes existuje: id `ec8d11b9-cdc3-4da8-8c12-138e0203ec05`, `meta.source_status=grounded`, 4 bloky, title „Tundrupek: Velitelské Stanoviště Záchranné Mise Timmy".
- Karta v UI dnes žije v `src/components/did/DidDailyBriefingPanel.tsx`, řádky **2241–2324**. Renderuje se uvnitř velkého panelu „Karlův přehled" (`KarelOverviewPanel.tsx`).
- V té kartě dnes vidíš: `ProposedPlayroomSourceBadge` (badge „Živý program (grounded)"), `ProposedPlayroomDebugPanel` (grounding tokens/render path), title, Cíl, Proč dnes, kontext, goals, blocks, child-safe, stop rules.
- Žádné ze sekcí, které požaduješ (Karlova promluva, Co víme z minulé herny, Pracovní dedukce, Doporučení pro Haničku/Káťu odděleně, Inline otázky před schválením, Post-session payload, Writeback overview), v tomto surface dnes neexistuje jako data ani jako UI.

## Rozsah, který navrhuju udělat v této iteraci (FRONTEND-ONLY)

Ohraničený, klinicky bezpečný slice — **bez backend změn**, **bez nových DB polí**, **bez nových edge functions**. To, co data dnes nedávají, se v UI **nesimuluje**; sekce se buď vůbec nezobrazí, nebo zobrazí honest „chybí podklad" stav.

### A) REMOVE (produkční terapeutický view)

V `DidDailyBriefingPanel.tsx` v sekci „Návrh pro dnešní hernu" (2241–2324):

1. Odstranit `<ProposedPlayroomSourceBadge>` (řádky 2259, 2288).
2. Odstranit `<ProposedPlayroomDebugPanel>` (řádek 2291) z produkčního renderu — ponechat ho **jen** za `karelDebugMode()` guardem (URL `?karelDebug=1` nebo `localStorage.karel_debug==='1'`), v souladu s P33.6 §7.
3. Odstranit jakýkoli viditelný text obsahující `source_status`, `quality_score`, `token_count`, `attempts`, `render path`, `eligible candidates`, `has_playroom_plan`, `has_therapeutic_program`, `selected plan id`, `created_at` z hlavního surface (audit ostatních míst panelu, nejen této sekce).
4. Odstranit duplicitní opakování názvu/jednovětého shrnutí (Cíl + title bývá dvakrát).
5. Sekce typu „Lidský návrh k poradě" v tomto panelu — pokud existuje, smazat (potřebuju ověřit, kde přesně, není to v 2241–2324; viz Otevřené otázky #1).
6. Ozdobné chipy `approval_label` / `lead_label` (řádky 2286–2287), pokud nemají workflow akci, zmenšit/odstranit (Otázka #2).

### B) RENAME

- Hlavní header sekce: zachovat „**Plán dnešní herny**" (dnes je tam „Návrh pro dnešní hernu" — sjednotím na zadanou frázi).
- Subsekce uvnitř karty přejmenovat na: „Karlova promluva", „Proč právě dnes", „Co víme z minulé herny", „Pracovní dedukce", „Co zůstává nejasné", „Doporučení pro dnešek", „Doporučení pro Haničku", „Doporučení pro Káťu", „Návrh programu herny", „Otázky před schválením", „Co zapsat po sezení".

### C) ADD — UI sekce v tomto pořadí (data-driven, bez fabrikování)

Mapování proti tomu, co dnes opravdu máme v `playroomProposal` / `did_daily_session_plans.urgency_breakdown.playroom_plan`:

| Sekce | Zdroj dat dnes | Když data chybí |
|---|---|---|
| 1. Karlova promluva k terapeutkám | `playroom_plan.opening_monologue` (pokud existuje) jinak `meta.karel_opening` | sekce se **nezobrazí** |
| 2. Proč právě dnes | `playroomProposal.rationale` (už je) | nezobrazí |
| 3. Co víme z minulé herny | `playroom_plan.last_session_summary.{happened, not_happened, worked, destabilized, stop_signals}` | „Z minulé herny zatím nemám podklad." (single line, žádné fabrikování) |
| 4. Pracovní dedukce | `playroom_plan.deductions.{confirmed, working, unknowns}` | nezobrazí |
| 5. Dnešní směr práce | `playroom_plan.direction.{phase, readiness, goal_primary, not_today, contraindications, stop_rules, fallback}` | částečné — vyplním jen pole, která mám |
| 6. Doporučení pro Haničku | `playroom_plan.therapist_actions.hanka[]` | nezobrazí |
| 7. Doporučení pro Káťu | `playroom_plan.therapist_actions.kata[]` | nezobrazí |
| 8. Návrh programu herny | `playroomView.blocks` (už je) | nezobrazí |
| 9. Otázky před schválením | `playroom_plan.pre_approval_questions[]` | nezobrazí |
| 10. Co zapsat po sezení | statický odkaz „Otevřít post-session formulář" — viz D) |
| 11. Co se zapíše dál | statický popis writeback destinací (text, ne live status) |

**Klíčové pravidlo:** pokud daný klíč v reálném DB řádku není, sekci v UI **nezobrazím**. Žádné placeholder věty „Karel zatím nemá k tomu informace…" pro každou prázdnou sekci. Jediná výjimka: sekce 3 (poslední herna), kde honest single-line „nemám podklad" je víc terapeuticky hodnotná než žádná informace.

### D) Inline otázky + Post-session payload (frontend stub)

- „Otázky před schválením" jako interaktivní `<textarea>` per otázka, ukládá se do **stávající** tabulky `did_pending_questions` (existuje, používá ji `PendingQuestionsPanel`). Žádné nové schéma.
- „Co zapsat po sezení" jako tlačítko otevírající existující `DidPostSessionInterrogation` modal (už v kódu existuje). Pokud schéma postpayloadu v něm neodpovídá tvému seznamu (whatHappened, confirmedFacts, …), to je **další iterace** — viz Otevřené otázky #3.

## Co vědomě **NEDĚLÁM** v této iteraci (a říkám to nahlas)

1. **Žádné nové DB sloupce / nové tabulky / nové RLS.** Pole jako `treatmentPhase`, `readinessToday`, `goalTodayPrimary`, `notToday`, `contraindications`, `stopRules`, `fallbackIfUnavailable`, `outcomeDefinition*` dnes v `playroom_plan` JSONu nejsou. Jejich systémové zavedení (kde se generují, kdo je ukládá, jak je validuje briefing truth gate) je samostatný backend ticket.
2. **Žádná změna `karel-did-auto-session-plan` edge function** — generátor `playroomGroundedPlan.ts` musí začít plnit nová pole (`last_session_summary`, `deductions`, `direction`, `therapist_actions`, `pre_approval_questions`). Bez toho zůstanou nové sekce skryté = correct behavior, ale tohle je **single biggest blocker** pro to, abys reálně viděl všechny nové sekce vyplněné. Říkám to dopředu.
3. **Žádný nový post-session analyzer** (whatHappened/confirmedFacts/workingDeductions/unknowns/dataValidity/writebacks). To je nová pipeline; dneska máme jen `DidPostSessionInterrogation` který je strukturován jinak.
4. **Žádné writeback gating na low validity** — to je backend logika v post-session pipeline, ne UI.
5. Žádné refaktorování `KarelOverviewPanel` / dashboardu mimo tu jednu kartu.

## Otevřené otázky pro tebe — než začnu psát kód

1. **„Lidský návrh k poradě"** — najdu a smažu. Souhlasíš, že kdykoli na to v projektu narazím (i mimo tuto kartu), smažu? Nebo jen v této kartě?
2. **Chipy `approval_label` a `lead_label`** vedle názvu části: navazují na něco? Mám je úplně odstranit, nebo přesunout pod „Co zapsat po sezení" jako stav schválení?
3. **Post-session formulář:** mám teď jen otevřít existující `DidPostSessionInterrogation`, nebo chceš, abych v této iteraci přidal nový formulářový komponent s tvým přesným seznamem polí (whatHappened, confirmedFacts, workingDeductions, unknowns, dataValidity, whatHelped, whatFailedOrBackfired, implicationsForNextPlan, requiredFollowupsForHanka/Kata, writebacks, analysisStatus, reviewDueAt) — bez backendové persistence (jen `localStorage` draft + `did_pending_questions` insert)?
4. **Backend brief pro generátor:** chceš, abych po této UI iteraci sepsal **samostatný** plán pro úpravu `playroomGroundedPlan.ts` (nové JSON pole + prompty) a teprve pak ho s tvým souhlasem implementoval? Pokud ne, nové sekce zůstanou prázdné dokud generátor nezačne plnit.

## Acceptance, které tahle iterace splní (a které ne)

Splní:
- Žádný debug text/badge v produkčním view (✓ acceptance #1).
- Program herny už není jediný obsah karty (✓ #5) — i pokud jen s honest „chybí podklad" sekcemi.
- Sekce inline otázek existuje a ukládá do `did_pending_questions` (✓ #6).

Nesplní bez backend iterace:
- Karlova profesionální promluva (#2) — bude prázdné, dokud generátor neplní `opening_monologue`.
- Oddělení facts/deductions/unknowns (#3) — totéž.
- Konkrétní doporučení pro Haničku/Káťu (#4) — totéž.
- Post-session 3-min payload + analýza (#7, #8) — vyžaduje novou pipeline.

## Soubory, kterých se v této iteraci dotknu

- `src/components/did/DidDailyBriefingPanel.tsx` — sekce 2241–2324 + audit zbytku panelu na zakázané technické termíny.
- (případně) `src/components/did/DidPostSessionInterrogation.tsx` — pouze kdyby otázka #3 → ano.
- nový: `src/components/did/PlayroomPreApprovalQuestions.tsx` — inline otázky.

Žádné jiné soubory bez tvého explicitního souhlasu.

---

**Než napíšu jediný řádek kódu, potřebuju od tebe:**
- odpovědi na otázky 1–4 výše,
- a explicitní „ANO, tento scope schvaluju" nebo úpravu rozsahu.
