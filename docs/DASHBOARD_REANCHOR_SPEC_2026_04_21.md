# DASHBOARD RE-ANCHOR SPEC — DID/Terapeut

**Datum:** 2026-04-21
**Pass:** Slice 2 — read-only specification (žádný kód)
**Vstup:** `docs/DASHBOARD_INVENTORY_2026_04_21.md` (Slice 1)
**Source-of-truth:** Roadmap (F2–F7), Operating Model, Runtime Architecture Lock, Crisis Layer Reprogram Plan, Governance prompt
**Cíl:** Zamknout architektonická rozhodnutí, podle kterých se v Slice 3 udělá implementační cleanup.
**Status:** ŽÁDNÝ KÓD V TOMTO PASSU. Pouze závazná architektonická specifikace.

---

## A. CÍLOVÝ OWNERSHIP MODEL DASHBOARDU

Dashboard `DID/Terapeut` se zamyká do **přesně 5 vrstev**. Každý blok dostane právě jednu. Žádné překryvy, žádný blok nesmí žít ve dvou vrstvách současně.

### A1. Pět vrstev (závazné názvy)

| # | Vrstva | Účel | Odpovídá fázi |
|---|---|---|---|
| 1 | **Decision Deck** (Karlův přehled) | Dnešní klinické závěry, deficity, blokující rozhodnutí | F3 + F4 + F7 |
| 2 | **Execution Layer** (Operativa dne) | Co se dnes skutečně dělá: today plans, command crisis cards, dnešní queue | F2 + F6 |
| 3 | **Coordination Layer** (Porady) | Týmové porady (deliberations) | F2 (porada-as-decision) |
| 4 | **Planning Layer** (Session planning) | Plánování + schvalování sezení | F7 (Daily Karel session rule) |
| 5 | **Inspect / Admin Layer** | Servis, registry, cleanup, health, raw data | mimo denní decision |

### A2. Mapa každého bloku do své vrstvy (jediný owner)

| Blok | Cílová vrstva | Aktuální umístění | Akce v Slice 3 |
|---|---|---|---|
| `KarelOverviewPanel` (briefing + foundation) | Decision Deck | Pracovna #1 | KEEP |
| `DidDailyBriefingPanel` | Decision Deck (uvnitř Overview) | Pracovna #1 | KEEP |
| `KarelCrisisDeficits` | Decision Deck (uvnitř Overview) | Pracovna #1 | KEEP |
| Therapist/Part mini-cards | Decision Deck (uvnitř Overview) | Pracovna #1 | KEEP |
| `CommandCrisisCard` | Execution Layer | Pracovna #2 (Dashboard) | KEEP — ale `OtevřítDetail` musí volat `useCrisisDetail()` (viz C) |
| `DidDailySessionPlan` | Planning Layer | Pracovna #2 (Dashboard) | KEEP |
| `TeamDeliberationsPanel` | Coordination Layer | Pracovna #2 (Dashboard) | KEEP |
| `OpsSnapshotBar` | Execution Layer (čítače) | Pracovna #2 (Dashboard) | KEEP, ale buď klikatelné nebo demote na footer (viz E4) |
| `KarelDailyPlan` (současný 1575 LOC monolit) | — | Pracovna #2 (Dashboard) | **DECOMPOSE** (viz F) |
| `WorkflowButton`s sekce 3 | Communication Surface (jediný) | Pracovna #3 + Komunikace surface | **REMOVE z Pracovny** (Komunikace je drží) |
| `DidSprava` Dialog | Inspect / Admin Layer | otevírá se z Pracovny header | **PŘESUN do AdminSurface** (viz G) |
| `CrisisAlert` | Signal (mimo 5 vrstev — sticky banner) | mountnutý v `Chat.tsx` | KEEP (single signal owner) |
| `CrisisDetailWorkspace` | Decision Deck pracovní plocha (otevíraná z banneru/deficitů) | Sheet přes `useCrisisDetail` | KEEP — **single crisis detail owner** (viz C) |
| `DidCrisisPanel` | — | Sheet z `CommandCrisisCard` | **REMOVE jako paralelní owner** (wrapper redirect na `openCrisisDetail()`) |
| `DidSprava → Krize` tab | — | uvnitř DidSprava dialogu | **REMOVE** (legacy entry, redirect na `openCrisisDetail()`) |

### A3. Source vs Display vs Action — pro každou vrstvu

| Vrstva | Source | Display | Action |
|---|---|---|---|
| Decision Deck | `did_daily_briefings`, `karel_working_memory_snapshots`, derived crisis deficits | `KarelOverviewPanel` + sub-bloky | Otevřít detail krize, otevřít odpovědní vlákno, schválit návrh sezení |
| Execution Layer | `karel-daily-dashboard.snapshot`, `did_daily_session_plans`, derived counters | `CommandCrisisCard`, `DidDailySessionPlan` (pro execution side), `OpsSnapshotBar`, **nový** `OperationalBacklogPanel` (viz F) | Spustit / ukončit sezení, odpovědět na otázku, odbavit task |
| Coordination Layer | `did_team_deliberations` | `TeamDeliberationsPanel` | Otevřít poradu, podepsat, svolat novou |
| Planning Layer | `did_daily_session_plans`, briefing.proposed_session | `DidDailySessionPlan` (pro planning side) | Generovat plán, schválit, převést z deliberation |
| Inspect / Admin | 21 admin tabů + WM + Drive queue + Registry | `AdminSurface` (skutečná hostitelská plocha) | Force cycle, force fail, audit, reformat, cleanup |

---

## B. LIFECYCLE MODE DECISION

### B1. Rozhodnutí: **logický lifecycle contract nad existujícími tabulkami**

**Nepoužívat schema migration v Slice 3.** Sjednotíme lifecycle jako **derived view-model** nad `did_therapist_tasks` + `did_pending_questions` + briefing waiting + crisis deficits + session proposals. Implementace v Slice 3 = `src/lib/dailyLifecycleResolver.ts` + jediný `useDailyLifecycle()` hook.

**Důvody:**
- Governance prompt zakazuje monolitické refaktory.
- Schema migration na 2+ tabulky je risk pro běžící krizový režim.
- Inventory ukázal, že lifecycle už **fakticky existuje implicitně** v polích (`status`, `created_at`, `updated_at`, `answered_at`, `expires_at`). Stačí jednotná interpretace.

### B2. Logický lifecycle (8 stavů)

| Stav | Význam | Patří do Decision Deck? | Patří do Execution? | Patří do backlog? |
|---|---|---|---|---|
| `new_today` | Vznikl dnes (created_at >= today_prague_start) | ✅ | ✅ | ✗ |
| `waiting_response` | Karel poslal otázku/úkol, čeká odpověď, < 48h | ✅ jen pokud blokuje rozhodnutí | ✅ | ✗ |
| `needs_reissue` | Waiting > 48h, žádná odpověď, stále relevantní | ✅ | ✅ | ✗ |
| `escalate_to_meeting` | Karel rozhodl, že přesahuje 1:1 task → svolat poradu | ✅ | ✗ | ✗ |
| `scheduled_for_session` | Položka je vázaná na konkrétní `did_daily_session_plans` row | ✗ | ✅ | ✗ |
| `done` | Status = answered/done | ✗ | ✗ | ✅ (history) |
| `dropped` | Karel rozhodl, že není už relevantní (manuální nebo daily-cycle decision) | ✗ | ✗ | ✅ (history) |
| `not_relevant_anymore` | Auto-drop: > 14 dní bez akce, žádný blokující kontext | ✗ | ✗ | ✅ (history) |

### B3. Mapping per source

#### B3.1 `did_therapist_tasks`
- `status='pending'` + `created_at >= today_prague_start` → `new_today`
- `status='pending'` + `assigned_to set` + věk ≤ 48h → `waiting_response`
- `status='pending'` + věk > 48h ∧ ≤ 14d → `needs_reissue` (vyžaduje ranní decision)
- `status='pending'` + věk > 14d → `not_relevant_anymore` (auto-drop kandidát)
- `status='done'` → `done`
- `status='archived'` → `dropped`
- `status='expired'` → `not_relevant_anymore`

**Source:** `did_therapist_tasks`
**Co se děje při ranním auditu:** `karel-did-daily-cycle` Phase X (nový krok v Slice 3 backend) projde všechny `needs_reissue` a per task vydá rozhodnutí (`reissue` / `escalate` / `drop` / `defer_to_session`). Audit se zapisuje do `did_lifecycle_decisions` (nová tabulka v Slice 3 backend pass — NE v UI Slice 3).
**Co se zobrazuje v Karlově přehledu:** jen `new_today` + `needs_reissue` + `escalate_to_meeting` + `waiting_response` které blokují (mají `blocking=true` flag — derived z briefingu).
**Co se zobrazuje jen v operativě:** `scheduled_for_session` + plný `waiting_response` set.
**Co spadne do backlog/history:** `done` + `dropped` + `not_relevant_anymore` (jen v `DidSprava → Cleanup` tabu, ne v Operativě).

#### B3.2 `did_pending_questions`
- `status='pending'` + dnes → `new_today`
- `status='pending'` + ≤ 48h → `waiting_response`
- `status='pending'` + > 48h, ≤ 14d → `needs_reissue`
- `status='answered'` → `done`
- `status='closed'` → `dropped`

**Source:** `did_pending_questions`. Zbytek viz B3.1.

#### B3.3 Briefing waiting items (`ask_hanka` / `ask_kata` / `waiting_for`)
- Stateless snapshot — derived každé ráno od briefingu.
- Lifecycle se odvozuje z **párovaného** `did_therapist_tasks` / `did_pending_questions` row, pokud existuje (`linked_briefing_item_id`).
- Pokud párovaný row neexistuje → vždy `new_today` (briefing tvrdí, že je dnes potřeba).

**Source:** derived. **Display:** Decision Deck (briefing). **Action:** generuje task / otázku, který pak žije svým lifecyclem.

#### B3.4 Crisis deficits
- `useCrisisOperationalState` → derived runtime: `missing_interview` / `missing_feedback` / `stale`.
- Lifecycle = vždy `new_today` dokud existují (přepočítáváno per request).

**Source:** derived. **Display:** Decision Deck (`KarelCrisisDeficits`). **Action:** otevřít `CrisisDetailWorkspace`.

#### B3.5 Session proposals
- Lifecycle už existuje canonicky: `did_team_deliberations.status` (active → awaiting_signoff → completed) → `did_daily_session_plans.status` (generated → in_progress → done/skipped).
- Mapping: deliberation `active` → `new_today` (pokud dnes vytvořeno) nebo `waiting_response`. Po signoff → `scheduled_for_session`. Po execution → `done`.

**Source:** `did_team_deliberations` + `did_daily_session_plans`. **Display:** Coordination + Planning. **Decision Deck** zobrazuje jen briefing.proposed_session (návrh PŘED deliberation) a deliberations s `escalate_to_meeting` flagem.

### B4. Ranní audit (decision contract)

V Slice 3 frontendu = **filtering only**. Backend audit job je out-of-scope pro tento UI re-anchor pass (bude separátní pass).

Frontend Slice 3 musí:
1. načíst surové rows
2. proběhnout `dailyLifecycleResolver.ts` (čistá funkce: `(rows, now) => Map<rowId, LifecycleState>`)
3. vrátit do UI klasifikované sety (`newToday[]`, `needsReissue[]`, `escalateToMeeting[]`, `scheduledForSession[]`, `done[]`, `dropped[]`)
4. UI gating: Decision Deck ukáže jen first 3 + blocking subset of `waiting_response`. Operativa ukáže `newToday` + `needsReissue` + `scheduled_for_session` + plný `waiting_response`. Backlog/history surface (`DidSprava → Cleanup`) ukáže `done` + `dropped` + `not_relevant_anymore`.

---

## C. SINGLE CRISIS DETAIL OWNER

### C1. Rozhodnutí: **`CrisisDetailWorkspace` + `useCrisisDetail()` = jediný owner**

`DidCrisisPanel` v Slice 3:
- **NEodstranit fyzicky** (ještě používá `DidSprava → Krize` tab a má vnitřní logiku, kterou je riziko ihned smazat)
- **Zamknout jako wrapper redirect**: vstupní bod (`CommandCrisisCard.OtevřítDetail`, `DidSprava → Krize`) **nesmí** otevírat `<Sheet><DidCrisisPanel /></Sheet>`. Místo toho volá `openCrisisDetail(crisisId)` z `useCrisisDetail()`.

### C2. Rerouting matrix

| Vstupní bod | Aktuální chování | Cílové chování (Slice 3) |
|---|---|---|
| `CrisisAlert` „Detail" toggle | `openCrisisDetail(id)` → `CrisisDetailWorkspace` Sheet | KEEP |
| `KarelCrisisDeficits` „Otevřít detail" | `openCrisisDetail(id)` → `CrisisDetailWorkspace` Sheet | KEEP |
| `CommandCrisisCard` „Otevřít detail" | `<Sheet><DidCrisisPanel /></Sheet>` (paralelní) | **REWRITE**: `openCrisisDetail(crisisEventId ?? partName)` → `CrisisDetailWorkspace` Sheet |
| `DidSprava → Krize` tab | inline `<DidCrisisPanel />` | **REMOVE tab** + (volitelně) přidat tlačítko „Otevřít aktivní krize → Workspace" které volá `openCrisisDetail()` per crisis |

### C3. `useCrisisDetail()` rozšíření (out-of-scope pro Slice 3 UI; jen pokud potřeba):
- Pokud `openCrisisDetail()` umí dnes jen `cardId` (string), ale potřebuje `crisisEventId | partName`, signature musí být zachována nebo rozšířena bez breakage. **Audit vstupu k upřesnění v Slice 3 implementation pass.**

### C4. Důsledek

Po Slice 3:
- **0 paralelních crisis detail Sheetů**
- **1 crisis detail Sheet** (`CrisisDetailWorkspace`)
- **3 vstupní body** (banner, deficits, command card)
- `DidCrisisPanel` může zůstat jako interní komponenta používaná **uvnitř** `CrisisDetailWorkspace` (pokud je tam reused). Není-li reused, je kandidát na deletion v separátním cleanup passu — **nebudeme ho mazat v Slice 3**.

---

## D. KARLŮV PŘEHLED FILTER CONTRACT

### D1. Závazný include filter

Do Karlova přehledu (`KarelOverviewPanel`) jde **jen**:

1. **Briefing payload** z `did_daily_briefings` (greeting, last_3_days, decisions, proposed_session, ask_hanka, ask_kata, waiting_for, closing) — všechny pole z dnešního briefingu
2. **Therapist Foundation mini-cards** (Hanka + Káťa) — z `karel_working_memory_snapshots.summary.therapist_state`
3. **Part Foundation mini-rows** — z `karel_working_memory_snapshots.summary.part_state`
4. **Crisis deficity** s `lifecycle_state ∈ { new_today, needs_reissue, escalate_to_meeting }` — z `KarelCrisisDeficits`
5. **Tasks/questions** s `lifecycle_state ∈ { new_today, needs_reissue, escalate_to_meeting }` (NOVÝ blok v Slice 3, derived z `dailyLifecycleResolver`)
6. **Waiting responses** jen pokud `blocking=true` flag (derived z briefingu nebo z task metadat, např. `requires_answer_for_today_session=true`)
7. **Dnešní session decisions** (briefing.proposed_session — návrh; schválené plány patří do Planning, ne sem)

### D2. Závazný exclude filter

Do Karlova přehledu **nesmí** jít:

- Celý backlog (cokoli `done` / `dropped` / `not_relevant_anymore`)
- `scheduled_for_session` items (patří do Execution)
- `waiting_response` bez `blocking=true` flag
- Plné task lists (Hanka all / Káťa all / Team all) — to je Operativa
- `OpsSnapshotBar` čítače
- Admin / Inspect / Health / Registry / Cleanup položky
- Live session indicators
- Workflow buttons (Hanička room launcher, Káťa room launcher, atd.)
- Message-to-therapist input box (vstupní formulář pro psaní vzkazů — to je Komunikace, ne Decision Deck)
- 5-odstavcový narrative briefing v jiné komponentě než `DidDailyBriefingPanel` (tj. KarelDailyPlan briefing-mode větev)

### D3. Order contract

Závazné pořadí bloků v `KarelOverviewPanel` (svrchu dolů):

1. `DidDailyBriefingPanel` (greeting, last_3_days, decisions)
2. `KarelCrisisDeficits` (jen pokud existují)
3. **NEW**: `DailyDecisionTasks` (z lifecycle resolver — `new_today` + `needs_reissue` + `escalate_to_meeting` napříč tasks/questions; jen pokud existují)
4. `DidDailyBriefingPanel` zbytek (proposed_session, ask_hanka, ask_kata, waiting_for, closing)
5. Therapist Foundation mini-cards (Hanka + Káťa)
6. Part Foundation mini-rows

**Poznámka:** Bod 4 vyžaduje refaktor `DidDailyBriefingPanel` na 2 sub-části (header + tail) **nebo** přesun `DailyDecisionTasks` do separátního místa. Spec preferuje zachovat `DidDailyBriefingPanel` celistvý a `DailyDecisionTasks` vsadit **mezi briefing a foundation** (po celém briefingu). Finální order = body 1 → 2 → briefing(celý) → 3 → 5 → 6.

### D4. Empty states

Každý sub-blok musí mít explicitní empty state. Žádný „pokud není data, neukázat sekci" bez signálu — to je důvod, proč přehled působí prázdně.

| Sub-blok | Empty state copy |
|---|---|
| Briefing | „Karel ještě dnes negeneroval přehled. [Refresh]" |
| Crisis deficits | „Žádné dnešní deficity — Karlův krizový pracovní seznam je vyčištěný." (existuje) |
| DailyDecisionTasks | „Dnes nic nového k rozhodnutí — všechny otevřené úkoly jsou pod kontrolou." |
| Therapist Foundation | „Foundation ještě neproběhl — počkej na další daily cycle." |
| Part Foundation | „Foundation ještě neproběhl — počkej na další daily cycle." |

---

## E. OPERATIVA DNE CONTRACT

### E1. Závazný include filter

Do Operativy dne (= aktuální `DidDashboard` minus KarelDailyPlan monolit) jde:

1. **Header s Refresh + Live indicator** (admin DidSprava launcher přesun do AdminSurface, viz G)
2. **`CommandCrisisCard`** (jen pokud `snapshot.command.crises.length > 0`)
3. **NEW**: `OperationalBacklogPanel` (náhrada za KarelDailyPlan — viz F2) — task lists s `lifecycle_state ∈ { new_today, waiting_response, needs_reissue, scheduled_for_session }`
4. **`TeamDeliberationsPanel`** (porady)
5. **„Dnes" sekce s `DidDailySessionPlan`** (session execution side)
6. **`OpsSnapshotBar`** (čítače) — viz E4

### E2. Závazný exclude filter

Do Operativy **nesmí** jít:

- Karlův denní hlas / 5-odstavcový narrativ (to je Decision Deck)
- Briefing.greeting / decisions / closing copies (to je Decision Deck)
- Foundation mini-cards (to je Decision Deck)
- Backlog dump (`done` / `dropped` / `not_relevant_anymore`)
- Admin tooling (DidSprava button přesun do Admin)
- Crisis detail uvnitř Operativy (Sheet je správně, ale ne inline)

### E3. Order contract

1. Header
2. `CommandCrisisCard` (conditional)
3. `OperationalBacklogPanel`
4. `TeamDeliberationsPanel`
5. `DidDailySessionPlan` (today section)
6. `OpsSnapshotBar` (footer position)

### E4. `OpsSnapshotBar` rozhodnutí

**Decision: KEEP, ale demote na footer + odstranit z viditelné výšky.**
- Není povinné dělat čítače klikatelné v Slice 3 (může být v separátním navigation pass).
- V Slice 3 minimálně: přesunout pod `DidDailySessionPlan`, zmenšit text, oddělit horizontální linkou.
- Důvod: čítače mají referenční hodnotu (terapeutka chce vědět, že má 47 vláken a 12 otázek), ale nesmí být první věc, kterou vidí.

---

## F. KARELDAILYPLAN DISPOSITION

### F1. Rozhodnutí: **DECOMPOSE — rozdělit na menší bloky, ne rozpustit a ne tvrdě odlehčit**

Hlasuji pro variantu **3 (rozdělit na menší bloky)** s následujícím odůvodněním:

**Proti rozpuštění (varianta 1):**
- KarelDailyPlan obsahuje **funkční operational backlog UI** (task lists per target, message-to-therapist boxy, sezení sekci), které **neexistuje jinde**. Rozpuštění by vytvořilo díru.

**Proti tvrdému odlehčení (varianta 2):**
- 1575 LOC v jednom souboru je governance violation samo o sobě (pravidlo: malé focused komponenty).
- briefing-mode větev (5-odstavcový narrativ) musí pryč úplně, ne jen být guarded — riziko leaku zůstává.
- task lists (Hanka/Káťa/Team) + message boxy + sezení = **3 funkčně oddělené věci** v jednom souboru.

**Pro decompose (varianta 3):**
- Cílová struktura:
  - **NEW** `OperationalBacklogPanel.tsx` (max ~300 LOC) — task lists per target s `dailyLifecycleResolver` filtrem. Žádný briefing-mode, žádný `fallbackCrisisPart` (čte z `useCrisisOperationalState`).
  - **NEW** `MessageToTherapistComposer.tsx` (max ~150 LOC) — vstupní pole pro vzkazy Hance/Kátě. Možná přesun do `Komunikace` surface, ale to je v Slice 3 polish, ne arch. Defaultně zůstává v Operativě jako sub-blok `OperationalBacklogPanel` nebo samostatně.
  - **NEW** `DailyDecisionTasks.tsx` (max ~200 LOC) — používá se v Decision Deck (D3 pořadí #3). Ukazuje jen `new_today` + `needs_reissue` + `escalate_to_meeting`.
  - **REMOVE** briefing-mode větev z `KarelDailyPlan` (5-odstavcový narrativ — `DidDailyBriefingPanel` ho už drží).
  - **REMOVE** `fallbackCrisisPart` resolver — `useCrisisOperationalState` je single source.
  - **REMOVE** decisions/unclear sekce — `DidDailyBriefingPanel.decisions` je single source.
  - **REMOVE** sezení sekce — `DidDailySessionPlan` je single source.
  - **DELETE** `KarelDailyPlan.tsx` jako celek po dokončení decompose.

**Ospravedlnění proti zdrojům:**
- **Roadmap:** F2 (Operational state model) říká, že operations layer musí mít čistý lifecycle. Současný KarelDailyPlan ho nemá.
- **Operating Model:** každý blok má mít jednu vrstvu. KarelDailyPlan má 3 (briefing + execution + planning).
- **Runtime Lock:** žádné paralelní voice generators → briefing musí pryč.
- **Inventory nálezy:** 1575 LOC, 7 SQL tabulek, 2 režimy (briefing + backlog), guarded `hideDuplicateBlocks` jako band-aid.

### F2. Cílový výstup `OperationalBacklogPanel`

```
┌─ Header: „Operativní backlog" + filtr (All / Hanka / Káťa / Team)
├─ Group: Hanka
│  ├─ Task row (lifecycle badge + title + age + actions: Done / Reissue / Drop)
│  └─ ...
├─ Group: Káťa
├─ Group: Team
└─ Footer: „X done / Y dropped za posledních 7 dní → otevřít historii v Adminu"
```

Žádné decisions, žádný narrativ, žádné sezení sekce, žádný fallbackCrisisPart, žádné message boxy (volitelně samostatně).

---

## G. ADMIN / INSPECT OWNERSHIP

### G1. Rozhodnutí: **`AdminSurface` se stává skutečnou hostitelskou plochou**

Aktuální stav je inverzní: `AdminSurface` je prázdná mapa → `DidSprava` Dialog visí z Pracovny. Cíl:

- `AdminSurface` = vertikální stack admin nástrojů přímo embedovaný (NE Dialog launcher)
- `DidSprava` Dialog komponenta zůstane jako technický kontejner (drží 21 tabů), ale otevírá se z **AdminSurface**, ne z Pracovny header
- Pracovna header **odstraní** `DidSprava` button

### G2. Co zůstane v Pracovně

| Item | Důvod |
|---|---|
| Header s Refresh + Live indicator | Operativa potřebuje refresh trigger |
| Decision Deck (Karlův přehled) | core daily decision |
| Execution Layer (operativa, command crisis, deliberations, session plan, ops bar) | core daily execution |
| Crisis detail Sheet (`CrisisDetailWorkspace`) | otevírá se z bannerů — UX correctness |

### G3. Co se přesune do AdminSurface

| Item | Aktuální místo | Cílové místo |
|---|---|---|
| `DidSprava` Dialog launcher | Pracovna header | AdminSurface (jako tlačítko nebo přímo embedded tabs) |
| Workflow button „Otevřené porady" | Pracovna sekce 3 | Komunikace (už tam je) — z Pracovny **REMOVE** |
| Workflow button „Live DID sezení" | Pracovna sekce 3 | Komunikace — **REMOVE z Pracovny** |
| Workflow button „Hanička room" | Pracovna sekce 3 | Komunikace — **REMOVE z Pracovny** |
| Workflow button „Káťa room" | Pracovna sekce 3 | Komunikace — **REMOVE z Pracovny** |
| `DidSprava → Krize` tab | uvnitř DidSprava | **REMOVE** (viz C2) |

### G4. Minimální správná migrace pro Slice 3

**MINIMUM (povinně v Slice 3):**
1. Přesun `DidSprava` launcheru z `DidDashboard` headeru do `AdminSurface`
2. Odstranění `WorkflowButton`s sekce 3 z Pracovny (Komunikace surface je drží)
3. Odstranění `DidSprava → Krize` tab + redirect na `openCrisisDetail()`

**OUT OF SCOPE pro Slice 3 (separátní pass):**
- Refaktor 21 tabů `DidSprava` na vertikální AdminSurface stack
- Klikatelnost `OpsSnapshotBar` čítačů
- Backend lifecycle decision job

---

## H. CRISIS LAYER TARGET PLACEMENT

Závazná cílová mapa po Slice 3:

| Layer | Komponenta | Vstup | Akce |
|---|---|---|---|
| **Signal** | `CrisisAlert` (sticky banner) | mountnutý v `Chat.tsx` | jen „Detail" toggle → `openCrisisDetail()` |
| **Decision (deficity)** | `KarelCrisisDeficits` v `KarelOverviewPanel` | `useCrisisOperationalState` | per deficit „Otevřít detail" → `openCrisisDetail()` |
| **Operational command** | `CommandCrisisCard` v Operativě | `snapshot.command.crises` | 2 CTA + „Otevřít detail" → `openCrisisDetail()` (NE inline DidCrisisPanel) |
| **Detail workspace (single owner)** | `CrisisDetailWorkspace` Sheet | `useCrisisDetail()` | full pracovní plocha krize |
| **Execution context** | `DidDailySessionPlan` crisis-session block | `did_daily_session_plans` + `crisis_events` | spustit krizové sezení |
| **Coordination** | porada s `type='crisis'` v `TeamDeliberationsPanel` | `did_team_deliberations` | porada-as-decision |
| **Admin / Inspect** | (žádný — `DidSprava → Krize` REMOVE) | — | — |
| **Historie** | `CrisisHistoryTimeline` (uvnitř `CrisisDetailWorkspace` nebo v AdminSurface) | `crisis_events` (closed phase) | read-only audit |

**Crisis layer po Slice 3 = 7 vrstev s 0 duplicitami.**

---

## I. SLICE 3 IMPLEMENTATION CHECKLIST

Konkrétní rework seznam pro Slice 3 (NE obecné body). Každá položka má cílový soubor a cílový stav.

### I1. Remove / hide legacy

- [ ] **Remove** `WorkflowButton`s sekce 3 z `PracovnaSurface` (4 buttony: Otevřené porady / Live DID sezení / Hanička / Káťa)
- [ ] **Remove** `DidSprava` launcher z `DidDashboard` headeru
- [ ] **Remove** `DidSprava → Krize` tab uvnitř `DidSprava.tsx`
- [ ] **Remove** briefing-mode větev z `KarelDailyPlan` (5-odstavcový narrativ + ask_hanka/ask_kata/proposed_session/waiting_for/closing — `DidDailyBriefingPanel` je single owner)
- [ ] **Remove** `fallbackCrisisPart` resolver z `KarelDailyPlan` (`useCrisisOperationalState` je single source)
- [ ] **Remove** decisions/unclear sekce z `KarelDailyPlan` (`DidDailyBriefingPanel.decisions` single source)
- [ ] **Remove** sezení sekce z `KarelDailyPlan` (`DidDailySessionPlan` single source)
- [ ] **Delete** `KarelDailyPlan.tsx` jako poslední krok decompose

### I2. Unify crisis detail owner

- [ ] **Rewrite** `CommandCrisisCard.OtevřítDetail` z `<Sheet><DidCrisisPanel /></Sheet>` na `openCrisisDetail(crisisEventId ?? partName)`
- [ ] **Verify** že `useCrisisDetail()` přijímá `crisisEventId | partName` — pokud ne, audit a rozšířit signature bez breakage
- [ ] **Keep** `DidCrisisPanel.tsx` jako interní reused komponentu uvnitř `CrisisDetailWorkspace` (NE smazat v tomto passu)
- [ ] **Verify** `CrisisAlert` + `KarelCrisisDeficits` stále otvírají `CrisisDetailWorkspace` (regression check)

### I3. Lifecycle filtering

- [ ] **Create** `src/lib/dailyLifecycleResolver.ts` — pure function `(rows, now) => Map<rowId, LifecycleState>` per source (tasks, questions, briefing waiting, crisis deficits, session proposals)
- [ ] **Create** `src/hooks/useDailyLifecycle.ts` — wraps resolver + per-category sety (`newToday[]`, `waitingResponse[]`, `needsReissue[]`, `escalateToMeeting[]`, `scheduledForSession[]`, `done[]`, `dropped[]`)
- [ ] **Create** `src/types/dailyLifecycle.ts` — enum + interfaces
- [ ] **Verify** resolver je čistá funkce (žádný side effect, deterministic per `now`)

### I4. Karlův přehled cleanup

- [ ] **Create** `src/components/did/DailyDecisionTasks.tsx` (max ~200 LOC) — render `newToday + needsReissue + escalateToMeeting` napříč tasks/questions z `useDailyLifecycle()`
- [ ] **Insert** `DailyDecisionTasks` do `KarelOverviewPanel` mezi briefing a Therapist Foundation (D3 order)
- [ ] **Verify** D2 exclude filter — žádný backlog dump v `KarelOverviewPanel`
- [ ] **Add** explicit empty states pro každý sub-blok (D4)

### I5. Operativa cleanup

- [ ] **Create** `src/components/did/OperationalBacklogPanel.tsx` (max ~300 LOC) — task lists per target s `lifecycle_state ∈ { new_today, waiting_response, needs_reissue, scheduled_for_session }` z `useDailyLifecycle()`
- [ ] **Create** `src/components/did/MessageToTherapistComposer.tsx` (max ~150 LOC) — vstupní pole pro vzkazy Hance/Kátě (přesun z `KarelDailyPlan`)
- [ ] **Insert** `OperationalBacklogPanel` do `DidDashboard` na místo `KarelDailyPlan`
- [ ] **Insert** `MessageToTherapistComposer` jako sub-blok `OperationalBacklogPanel` (nebo samostatně pod ním)
- [ ] **Move** `OpsSnapshotBar` na konec `DidDashboard` (pod `DidDailySessionPlan`)
- [ ] **Demote** `OpsSnapshotBar` text size + add separator above (footer position)

### I6. Admin migration

- [ ] **Add** `DidSprava` Dialog launcher do `AdminSurface` (button)
- [ ] **Verify** `AdminSurface` má jasný copy „Servis a inspekce" + popis 21 tabů
- [ ] **Out of scope:** refaktor 21 tabů na vertikální stack — separátní pass

### I7. Routing cleanup

- [ ] **Verify** `DidContentRouter` nezměnit (sub-routes: chat / meeting / live / kartoteka / pin-entry zůstávají)
- [ ] **Verify** `Komunikace` surface drží 4 workflow buttons (Hanička / Káťa / Porady / Live) — žádná duplicita s Pracovnou
- [ ] **Verify** žádný route obchází `useCrisisDetail()` při otevření crisis detailu

### I8. TypeScript / build proof

- [ ] **Run** `tsc --noEmit` — 0 errors
- [ ] **Verify** žádný import na smazaný `KarelDailyPlan` (Slice 3 final step)
- [ ] **Verify** žádný import na odstraněné WorkflowButtons z Pracovny (jen v Komunikace)

### I9. Runtime proof

- [ ] **Verify** Pracovna se renderuje bez 2 paralelních voice generators (briefing v `DidDailyBriefingPanel` jen 1×)
- [ ] **Verify** Otevřít detail krize z 3 vstupních bodů (banner / deficity / command card) → vždy 1 stejný `CrisisDetailWorkspace` Sheet
- [ ] **Verify** Karlův přehled neobsahuje backlog dump (only D1 set)
- [ ] **Verify** Operativa neobsahuje briefing copies (only E1 set)
- [ ] **Verify** AdminSurface má funkční launcher pro `DidSprava`

---

## ZÁVĚR — co je v Slice 2 zamčeno

1. **5-vrstvý ownership model:** Decision Deck / Execution / Coordination / Planning / Admin. Každý blok má právě jednu vrstvu.
2. **Lifecycle = derived view-model**, ne schema migration. 8 stavů, jednotný resolver, frontend filtering.
3. **Single crisis detail owner = `CrisisDetailWorkspace` + `useCrisisDetail()`**. `DidCrisisPanel` se rewriteuje jako interní wrapper, ne paralelní owner.
4. **Karlův přehled filter contract** (D1 include / D2 exclude / D3 order / D4 empty states).
5. **Operativa dne contract** (E1 include / E2 exclude / E3 order / E4 ops bar demote).
6. **`KarelDailyPlan` decision = DECOMPOSE** (varianta 3) → 3 nové komponenty + delete monolitu.
7. **AdminSurface jako skutečná hostitelská plocha.** `DidSprava` se přesouvá z Pracovny header do Adminu.
8. **Crisis layer 7-vrstvý mapping** s 0 duplicitami.
9. **Slice 3 checklist** s 9 sekcemi (I1–I9), každá s konkrétními akcemi a soubory.

**Out of scope pro Slice 3 (separátní pozdější pass):**
- Backend daily decision job (`karel-did-daily-cycle` Phase X)
- Schema migration `did_lifecycle_decisions`
- Refaktor 21 tabů `DidSprava` na vertikální AdminSurface stack
- Klikatelnost `OpsSnapshotBar` čítačů
- Smazání `DidCrisisPanel` (až po ověření, že není reused uvnitř `CrisisDetailWorkspace`)

**Připraveno k Slice 3 implementaci.**
