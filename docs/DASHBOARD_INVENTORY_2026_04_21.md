# DASHBOARD INVENTORY — DID/Terapeut

**Datum:** 2026-04-21
**Pass:** Slice 1 — read-only audit
**Scope:** Hlavní bloky `DID/Terapeut` proti Roadmap (F2–F7), Operating Model, Runtime Architecture Lock, Crisis Layer Reprogram Plan, Governance prompt.
**Stav repo:** žádné kódové změny — pouze auditní mapa.

---

## 0. Top-level surface struktura (jak ji uživatel vidí)

`DidContentRouter` → flow state machine. Po vstupu „Terapeut" se renderuje **`TerapeutSurfaces`** (3 top-level záložky):

| Surface | Komponenta | Co tam je |
|---|---|---|
| 🧠 **Pracovna** (default) | `PracovnaSurface` | vertical scroll-stack: `KarelOverviewPanel` (embedded) + `DidDashboard` + `WorkflowButton`s |
| 💬 **Komunikace** | `CommunicationSurface` | 4 vstupní tlačítka: Hanička / Káťa / Porady / Live |
| 🔧 **Admin** | `AdminSurface` | mapa admin nástrojů — ukazuje kde co najít, neotvírá samo |

Mimo `TerapeutSurfaces` žijí:
- `CrisisAlert` (sticky banner, mountuje se v `Chat.tsx` přes `CrisisDetailContext`)
- `DidSprava` Dialog (otevírá se z hlavičky `DidDashboard`, drží 21+ tabů)
- `DeliberationRoom` Dialog (otevírá se z `TeamDeliberationsPanel`)
- `Sheet` s `DidCrisisPanel` (otevírá se z `CommandCrisisCard`)

Pracovna je dnes hlavní denní plocha. Zbylé 2 záložky jsou navigační zkratky.

---

## A. FULL DASHBOARD INVENTORY

Bloky uvnitř **Pracovny** (svrchu dolů):

### A1. `KarelOverviewPanel` (embedded, sekce 1 v Pracovně)
- **Soubor:** `src/components/did/KarelOverviewPanel.tsx`
- **Co dnes zobrazuje:**
  - header „Karlův přehled" + Refresh tlačítko
  - **BLOCK A:** `DidDailyBriefingPanel` (Karlův denní hlas — greeting / last_3_days / decisions / proposed_session / ask_hanka / ask_kata / waiting_for / closing)
  - **BLOCK A2:** `KarelCrisisDeficits` (deficity z aktivních krizí: missing_interview / missing_feedback / stale)
  - **BLOCK B:** Therapist Intelligence Foundation mini-cards (Hanička + Káťa, support_need / activity / continuity / confidence)
  - **BLOCK C:** Part Intelligence Foundation mini-rows (per part: risk / activity / trajectory / care_priority)
- **Data:**
  - briefing → `did_daily_briefings.payload` (writer: `karel-did-daily-briefing` edge fn)
  - crisis deficits → hook `useCrisisOperationalState` → `crisis_events` (canonical)
  - therapist/part state → `karel_working_memory_snapshots.snapshot_json.summary.{therapist_state, part_state}` (writer: `karel-wm-bootstrap` / daily cycle Phase 8 dle paměti)
- **Writer:** edge fn `karel-did-daily-briefing` + `karel-did-daily-cycle` (WM snapshot)
- **Reader:** UI only (PracovnaSurface)
- **Vrstva:** **Karlův přehled** (decision deck)
- **Verdict:** **intelligence-driven** — přesně to, co Operating Model F3+F4+F7 říká, že má být v decision decku.

### A2. `DidDashboard` (sekce 2 v Pracovně — „Operativa dne")
- **Soubor:** `src/components/did/DidDashboard.tsx`
- **Co dnes zobrazuje:**
  1. Header — timestamp + live indicator + Refresh + `DidSprava` button
  2. **BLOCK 1 `CommandCrisisCard`** (jen pokud `snapshot.command.crises.length > 0`)
  3. **BLOCK 2 `KarelDailyPlan` s `hideDuplicateBlocks=true`** — hero-section. Skrývá narativ (briefing už ho vlastní), ale ponechává:
     - CommandFourSections (todayNew / todayWorse / todayUnconfirmed / todayActionRequired)
     - decisions
     - unclear items
     - vstupní pole pro vzkazy Hance/Kátě
     - task seznamy (hankaTasks / kataTasks / teamTasks)
     - sezení sekce
  4. **BLOCK 2b `TeamDeliberationsPanel`** — otevřené porady (max 2+1 overflow)
  5. **„Dnes" sekce s `DidDailySessionPlan`** — denní plány sezení + crisis session block + live session
  6. **`OpsSnapshotBar`** — čítače: Části / Vlákna / Otázky / Zápisy / Po termínu / Urgentní / Live plány / K archivaci
- **Data:**
  - snapshot → `karel-daily-dashboard` edge fn (cached v `localStorage` per Prague day)
  - parts/threads → `did_part_registry` + `did_threads`
  - tasks/questions/sessions → `KarelDailyPlan` načítá samostatně (`did_therapist_tasks`, `did_pending_questions`, `did_daily_session_plans`, `did_part_sessions`, `crisis_events`, `did_part_interviews`)
  - team deliberations → `did_team_deliberations` přes `useTeamDeliberations`
  - inbox counts → `useOperationalInboxCounts` (5 paralelních COUNT queries)
- **Writer:** žádný — pure reader
- **Reader:** UI only
- **Vrstva:** **mix Operativa dne + Karlův přehled rezidua** — viz A3
- **Verdict:** **intelligence-driven backbone, ale s viditelnými legacy/duplicate sekcemi** — `KarelDailyPlan` uvnitř má svůj 5-odstavcový narativ guarded `hideDuplicateBlocks`, ale stále drží task lists, decisions, unclear, message-to-therapist boxy které částečně překrývají briefing.

### A3. `KarelDailyPlan` (uvnitř DidDashboard, „Operativní backlog")
- **Soubor:** `src/components/did/KarelDailyPlan.tsx` (1575 řádků — ⚠ velký monolit)
- **Co dnes zobrazuje (s `hideDuplicateBlocks=true`):**
  - CommandFourSections (todayNew/Worse/Unconfirmed/ActionRequired) — ze snapshot.command
  - decisions z `did_part_interviews.karel_decision_after_interview`
  - unclear items z `did_part_interviews.what_remains_unclear`
  - **Task lists** — group by target (Hanka / Káťa / Team), s TaskFrameBadge (overdue/stale/k archivaci)
  - **Message-to-therapist boxy** (Hance / Kátě) — vstupní pole, pošle se přes `did_therapist_messages`
  - **Sekce sezení** — uniqueSessions s CTA „Zahájit / Live / Otevřít poradu"
- **Co skrývá (díky `hideDuplicateBlocks`):**
  - 5-odstavcový narrative briefing (Co vím / Co plyne / Co navrhuji / Hanička / Káťa)
  - „Návrh sezení na dnes"
  - „Haničko/Káťo, potřebuji od tebe"
  - „Čekám na vaše odpovědi"
- **Data:** přímý SQL na 7 tabulek (tasks, questions, sessions, threads, interviews, plan_05A_cached, crisis_events fallback)
- **Writer:** žádný — reader + sender pro vzkazy
- **Reader:** UI only
- **Vrstva:** **Operativa dne** + **stínový Karlův přehled** (5 odstavců se renderuje pokud `hideDuplicateBlocks=false` — což je jen v Pracovně guarded; nezávislé použití by produkovalo druhý briefing)
- **Verdict:** **legacy half-monolit** — má 2 ostře oddělené režimy (briefing-mode vs. backlog-mode) a stejné helpers jako `DidDailyBriefingPanel`. Je to přechodová vrstva před plnou migrací briefingu do `DidDailyBriefingPanel`. Aktuálně **funkčně překrývá:** decisions, task surface, message-to-therapist (vs. ask_hanka/ask_kata).

### A4. `CommandCrisisCard` (BLOCK 1 v DidDashboard)
- **Soubor:** `src/components/did/CommandCrisisCard.tsx`
- **Co zobrazuje:** stručný pruh za každou aktivní krizi — partName / state / severity / hours stale / „Dnes chybí" / „Karel vyžaduje" / 2 CTA buttony + „Otevřít detail" → Sheet s `DidCrisisPanel`
- **Data:** `snapshot.command.crises` (z `karel-daily-dashboard`)
- **Writer:** žádný
- **Reader:** UI
- **Vrstva:** **Operativa dne** (s deep-link do Crisis workspace)
- **Verdict:** **canonical command-style card** — odpovídá Crisis Layer Reprogram Planu. Velikost OK, vede do správného detail Sheet.

### A5. `TeamDeliberationsPanel` (BLOCK 2b)
- **Soubor:** `src/components/did/TeamDeliberationsPanel.tsx`
- **Co zobrazuje:** primary/overflow dělení otevřených porad, signoff progress, „Svolat" expand panel s 5 typy
- **Data:** `did_team_deliberations` přes `useTeamDeliberations` hook
- **Writer:** edge `karel-team-deliberation-create` (volaný z briefing nebo z UI „Svolat")
- **Reader:** UI; klik → `onOpenRoom` → otevře `DeliberationRoom` modal
- **Vrstva:** **Porady (coordination)**
- **Verdict:** **canonical** — přesně Coordination layer dle Operating Model.

### A6. „Dnes" sekce s `DidDailySessionPlan`
- **Soubor:** `src/components/did/DidDailySessionPlan.tsx` (946 řádků)
- **Co zobrazuje:** today plans z `did_daily_session_plans` (filter `plan_date=today`); generování plánu (`karel-did-auto-session-plan`); start/end/revert; krizový session block; live session embed (`DidLiveSessionPanel`); preference dialog; archivované plány expander
- **Data:** `did_daily_session_plans` + `crisis_events` (no `phase=closed`) + `did_part_registry` + `did_part_sessions`
- **Writer:** edge `karel-did-auto-session-plan`; přímý SQL update statusu
- **Reader:** UI
- **Vrstva:** **Session planning + Execution** (live session)
- **Verdict:** **canonical session execution panel** — jediný legitimní zdroj „dnešního plánu sezení". Mírně přetížený o crisis-session-with-today-plan logiku, ale nedupluje crisis ownership.

### A7. `OpsSnapshotBar`
- **Soubor:** uvnitř `DidDashboard.tsx` (function component na řádce 616)
- **Co zobrazuje:** flat lišta čítačů: Části / Vlákna / Otázky / Zápisy / Po termínu / Urgentní / Live plány / K archivaci. Capped na 99+.
- **Data:** `useOperationalInboxCounts` (5 COUNT queries) + parts/activeThreads z parent
- **Writer:** žádný
- **Reader:** UI
- **Vrstva:** **Operativa dne** (admin-style health pulse)
- **Verdict:** **derived** — počty bez akce. Klikatelné nejsou. Hraničí s **misplaced** (technický inspect prvek, ale obsahově patří do Operativy).

### A8. `KarelCrisisDeficits` (uvnitř KarelOverviewPanel BLOCK A2)
- **Soubor:** `src/components/did/KarelCrisisDeficits.tsx`
- **Co zobrazuje:** za každou aktivní krizi 1–3 řádky deficitů (chybí dnešní hodnocení / chybí feedback / dlouho bez kontaktu) s „Otevřít detail" CTA
- **Data:** `useCrisisOperationalState` + `useCrisisDetail` context
- **Writer:** žádný
- **Reader:** UI
- **Vrstva:** **Karlův přehled** (decision deck — co dnes blokuje rozhodnutí)
- **Verdict:** **intelligence-driven, správně umístěné** — přesně reallocation podle Crisis Layer Reprogram Planu (banner = signal, deficits = decision deck).

### A9. `WorkflowButton`s (sekce 3 v Pracovně)
- 4 buttony: Otevřené porady / Live DID sezení / Hanička room / Káťa room
- **Vrstva:** Communication / Coordination launcher
- **Verdict:** **derived navigation** — duplicita s `CommunicationSurface` (4× tytéž buttony). Operating Model F2–F7 je nikde nevyžaduje v Pracovně.

### A10. `CrisisAlert` (sticky banner, mimo TerapeutSurfaces)
- **Soubor:** `src/components/karel/CrisisAlert.tsx`
- **Co zobrazuje:** sticky pruh per aktivní krize: displayName / severity / state / daysActive / hours stale / „Detail" toggle → otevírá `CrisisDetailWorkspace` přes `useCrisisDetail`
- **Data:** `useCrisisOperationalState`
- **Writer:** žádný
- **Reader:** UI; **JEDINÝ** owner pro „kde je krizový detail" (po reprogram passu)
- **Vrstva:** **signalizační vrstva** (přesahuje Crisis workspace)
- **Verdict:** **canonical signal layer** — odpovídá Crisis Reprogram Plan. Ownership je čistý.

### A11. `DidSprava` Dialog (z hlavičky DidDashboard)
- **Soubor:** `src/components/did/DidSprava.tsx` (770 řádků, 21+ tabů)
- **Co zobrazuje:** tab bar s: Bezpečnost / Otázky / Zápisy / Packet / Předávka / Recovery / Live / Nástroje / Krize / Plán / Kartotéka / Paměť / Poznámky / Trendy / Cíle / Zdraví / Registr / Reporty / Cleanup / WM / Vzhled
- **Data:** každý tab má svůj zdroj
- **Writer:** mnoho — nástroje (bootstrap, audit, reformat, centrum-sync, cleanup-tasks, force-cycle, force_fail)
- **Reader:** UI hub
- **Vrstva:** **Admin / Inspect / Servis** — ALE viditelné z hlavičky Pracovny
- **Verdict:** **misplaced gateway** — Admin tooling sedí 1 click hluboko v hlavní pracovní ploše. AdminSurface tab je dnes jen prázdná mapa, která říká „jdi do Pracovny → Správa". To je inverze.

### A12. `DidContentRouter` — všechny non-Pracovna flow states
- entry, terapeut, meeting, did-kartoteka, live-session, pin-entry, therapist-threads, thread-list, part-identify, chat, loading
- většinou per-flow specialized panels (mimo audit této inventory protože nejde o dashboard surfaces, ale o sub-routes)

---

## B. ONE MEANING = ONE PLACE MATRIX

| Význam | Místa kde dnes žije | Source-of-truth | Duplikáty / leaky |
|---|---|---|---|
| **Aktivní krize (signal)** | (1) `CrisisAlert` sticky banner, (2) `CommandCrisisCard` v Dashboardu, (3) crisis hint v chat view (`activeCrisisBanner`), (4) `DidSprava` „Krize" tab | `crisis_events` (open phase) přes `useCrisisOperationalState` | `CrisisAlert` = signal, `CommandCrisisCard` = command-style operativní karta, `crisis hint v chatu` = derived ze stejného hooku — všechny čtou kanonicky. **OK po reprogram passu.** |
| **Krizové deficity (rozhodovací)** | (1) `KarelCrisisDeficits` v Karlově přehledu, (2) `CommandCrisisCard.missing[]` v Dashboardu | derived z `crisis_events` + interview/feedback/stale checks | **Mírná duplicita:** A4 ukazuje „Dnes chybí" a A8 to samé jako řádek deficitu. Stejný význam, dvě vizualizace. |
| **Dnešní úkoly pro Hanku/Káťu** | (1) `DidDailyBriefingPanel.ask_hanka/ask_kata`, (2) `KarelDailyPlan` task lists (Hanka/Káťa/Team), (3) `DidSprava` „Otázky" tab (PendingQuestionsPanel), (4) `OpsSnapshotBar` „Otázky" čítač | `did_therapist_tasks` + `did_pending_questions` (oddělené tabulky!) | **KRITICKÁ DUPLICITA bez jednoho zdroje:** ask_hanka/kata jsou briefing-derived stringy, KarelDailyPlan tahá `did_therapist_tasks` přímo, PendingQuestionsPanel tahá `did_pending_questions`. **3 nezávislé surfaces, 2 nezávislé tabulky, žádný shared lifecycle.** |
| **Návrh sezení na dnes** | (1) `DidDailyBriefingPanel.proposed_session`, (2) `DidDailySessionPlan` (dnešní plán z `did_daily_session_plans`), (3) `KarelDailyPlan` „Sezení" sekce | `did_daily_session_plans` (canonical pro execution); briefing.proposed_session je derived návrh, který jde přes `karel-team-deliberation-create(session_plan)` → signoff → bridge do plans | **Tok je správně, ale zobrazuje se 3×.** Briefing = návrh, Plan = schválený, KarelDailyPlan má rozšířený sezení blok pro úkoly typu „session". |
| **Otevřené porady** | (1) `TeamDeliberationsPanel` v Dashboardu, (2) `Komunikace` surface „Porady týmu" launcher, (3) `Pracovna` workflow button „Otevřené porady" | `did_team_deliberations` | (2) a (3) jsou jen launchery do meeting flow, ne sám seznam. Reader je v (1). **OK.** |
| **Aktivní vlákna** | (1) `OpsSnapshotBar` čítač, (2) `DidDashboard` parts/activeThreads loadDashboardData (využívá se v OpsSnapshotBar), (3) `DidThreadList` (per submode) | `did_threads` + `did_part_registry` | A2 a A7 jsou propojené (parent → bar). DidThreadList je v jiném flow. **OK, žádný problém.** |
| **Pending writes (Drive queue)** | (1) `OpsSnapshotBar` čítač „Zápisy", (2) `DidSprava` „Zápisy" tab (`WriteQueueInbox`) | `did_pending_drive_writes` | OK — bar je čítač, sprava je workspace. |
| **Tasks „k archivaci"** | (1) `OpsSnapshotBar` „K archivaci" čítač, (2) `KarelDailyPlan.TaskFrameBadge` jako label, (3) `DidSprava → Cleanup tasks` button (`runCleanupTasks` archivuje >7d) | `did_therapist_tasks` (status=pending, created_at < -7d, > -14d) | Visible window ceiling guard sjednocen na 14 dnů. **OK po sanity passu.** |
| **Therapist state (Hanka/Káťa stav)** | (1) `KarelOverviewPanel` BLOCK B (TherapistMiniCard), (2) `DidSprava → Trendy / Poznámky / Cíle` (per-therapist views) | `karel_working_memory_snapshots.summary.therapist_state` (foundation v3) | **OK** — overview = decision summary, sprava = detail tabs. |
| **Part state (per-part stav)** | (1) `KarelOverviewPanel` BLOCK C (PartMiniRow), (2) `DidRegistryOverview` (DidSprava → Registr), (3) `did_part_registry` flat seznam v Dashboard parts | `karel_working_memory_snapshots.summary.part_state` + `did_part_registry` | (1) = decision summary, (2) = admin registry, (3) = plain status pro OpsSnapshotBar. **OK.** |
| **Karlův denní hlas (greeting/decisions/closing)** | (1) `DidDailyBriefingPanel` (canonical po Surface Split 2026-04-20), (2) `KarelDailyPlan` 5-odstavcový narrative (skrytý guard `hideDuplicateBlocks`) | `did_daily_briefings.payload` | **DUPLIKACE potlačená propem.** Pokud se KarelDailyPlan někde použije bez `hideDuplicateBlocks`, vznikne druhý hlas. **Zdroj rizika.** |
| **CommandFourSections (todayNew/Worse/Unconfirmed/ActionRequired)** | (1) `KarelDailyPlan` uvnitř DidDashboard | `karel-daily-dashboard.snapshot.command.*` | Single owner. **OK.** |
| **Crisis detail workspace** | (1) `CrisisDetailWorkspace` Sheet z `useCrisisDetail` (otevírají ho `CrisisAlert` + `KarelCrisisDeficits`), (2) `DidCrisisPanel` Sheet z `CommandCrisisCard.OtevřítDetail` | různé readeři, ALE | **DUPLICITA:** „Otevřít detail krize" má 2 různé komponenty (`CrisisDetailWorkspace` vs `DidCrisisPanel`) podle toho, odkud klikneš. To je v rozporu s Crisis Reprogram Plan ownership claim („společný owner = useCrisisDetail()"). |

---

## C. INTELLIGENCE ATTACHMENT AUDIT

| Blok | Canonical snapshot? | Working Memory? | Therapist Intel? | Part Intel? | Daily audit? | Verdict |
|---|---|---|---|---|---|---|
| KarelOverviewPanel (overview header) | — | ✅ `karel_working_memory_snapshots` | ✅ summary.therapist_state | ✅ summary.part_state | ✅ briefing | **plně intelligence-driven** |
| DidDailyBriefingPanel | — | nepřímo (briefing je generován z WM) | nepřímo | nepřímo | ✅ `did_daily_briefings` | **intelligence-driven** |
| KarelCrisisDeficits | — | ne (čte přímo crisis_events derivaci) | — | částečně (crisis cards) | ✅ derived per request | **intelligence-driven (deficit vrstva)** |
| CommandCrisisCard | ✅ `snapshot.command.crises` | nepřímo přes karel-daily-dashboard | — | — | ✅ snapshot fresh | **canonical command** |
| DidDashboard parts/activeThreads | — | ne | — | ne (jen status z `did_part_registry`) | ne | **operational reader** (žádné intelligence) |
| KarelDailyPlan task/question/session lists | částečně (snapshot.command.* je zdroj 4-section) | ne | ne | ne | ne | **operational reader + sender** |
| TeamDeliberationsPanel | — | ne | ne | ne | ne | **operational reader** |
| DidDailySessionPlan | — | ne | ne | ne | ne | **operational execution** |
| OpsSnapshotBar | — | ne | ne | ne | ne | **derived counters** |
| WorkflowButtons (sekce 3) | — | ne | ne | ne | ne | **navigation residue** |
| CrisisAlert | ✅ `useCrisisOperationalState` | ne | ne | jen crisis cards | ✅ realtime | **canonical signal** |
| DidSprava (gateway) | ne | ne | ne | ne | ne | **admin gateway** |

**Závěr Intelligence audit:**
- Plně intelligence-driven jsou jen 3 bloky: `KarelOverviewPanel` (s briefing+foundation), `KarelCrisisDeficits`, `CommandCrisisCard`.
- Zbytek dashboardu = pure operational readers + senders. To je v pořádku — operativa nemá být AI-driven.
- **Risk:** `KarelDailyPlan` má vlastní 5-odstavcový narrativ, který ale není napojený na `did_daily_briefings`. Druhý nezávislý voice generator.

---

## D. DAILY TASK LIFECYCLE REALITY AUDIT

### D1. Tasks (`did_therapist_tasks`)
- **Vznik:** edge fns (`karel-did-daily-cycle`, `karel-task-feedback`, `karel-section-*`, `did-pipeline` extractors)
- **Čtení dnes:** `KarelDailyPlan.load()` filtruje:
  - `status != 'done'`, `assigned_to in (hanka,kata,both)`, `created_at >= -14d`
- **Lifecycle states:** v DB jen `pending` / `expired` / `archived` / `done` (audit `useOperationalInboxCounts` říká doslova: *„OPEN_TASK_STATUSES = ['pending']"*)
- **Co se s nimi ráno děje:** **NIC.** Žádný daily reissue / escalate / drop. Karel jen načítá `pending` <14d, OpsSnapshotBar ukáže overdue/urgent/stale, `runCleanupTasks` (manual, z DidSprava) může bulk-archive >7d.
- **Verdict:** **tichá akumulace** — staré pendingy se vrší, jediná „rozhodovací akce" je `TaskFrameBadge` štítek (po termínu / starší úkol / k archivaci) + manuální cleanup v Správě.
- **Chybí:** explicitní `lifecycle_state` enum (`new_today` / `waiting_response` / `needs_reissue` / `escalate` / `dropped` / `not_relevant_anymore`) + denní rozhodovací cycle.

### D2. Pending questions (`did_pending_questions`)
- **Vznik:** edge fns + briefing flow
- **Čtení:** `OpsSnapshotBar` čítač + `DidSprava → Otázky` tab + part-level v `PendingQuestionsPanel` (uvnitř Správy)
- **Lifecycle:** statuses dle `OPEN_QUESTION_STATUSES` konstanty (open / awaiting_evidence / answered / closed dle paměti `pending-questions-interaction`)
- **Co se ráno děje:** žádný daily auto-reissue. Otázky čekají, dokud terapeutka nezodpoví ve Správě nebo přes briefing ask_*.
- **Verdict:** **tichá akumulace** — totéž jako tasks, jen na druhé tabulce. Žádný unified lifecycle s `did_therapist_tasks`.

### D3. Session proposals
- **Vznik:** briefing.proposed_session → `karel-team-deliberation-create(session_plan)` → `did_team_deliberations` → po 3 podpisech bridge do `did_daily_session_plans` (přes signoff edge)
- **Lifecycle:** `did_team_deliberations.status` (active → awaiting_signoff → completed) → `did_daily_session_plans.status` (generated → in_progress → done/skipped)
- **Verdict:** **OK pipeline** — single canonical flow, idempotence řešená serverside přes `linked_briefing_item_id`.

### D4. Crisis deficits
- **Vznik:** derived runtime z `useCrisisOperationalState` (missing_interview / missing_feedback / stale)
- **Co se ráno děje:** automaticky přepočteno při každém načtení Pracovny
- **Verdict:** **nemají vlastní lifecycle** — jsou plně derived. To je správně.

### D5. Waiting items (briefing.waiting_for + ask_hanka/kata bez odpovědi)
- **Vznik:** každé ráno znovu vygenerováno briefingem
- **Lifecycle:** žádný — briefing je „stateless" snapshot dne. Když terapeutka odpoví v ask threadu, příští briefing už je nezahrne (nebo zahrne, dle interní logiky `karel-did-daily-briefing` — nemám potvrzeno).
- **Verdict:** **briefing je idempotentní snapshot, ne lifecycle vrstva**. Pokud terapeutka neodpoví 5 dní po sobě, ta samá `ask_hanka` se objeví 5× znovu, ale není to označené jako „opakovaná žádost" / „needs_reissue". Karel jen tiše opakuje.

### D6. Souhrn — chybí napříč všemi kategoriemi
- **Žádný unified `lifecycle_state`** přes tasks + questions + waiting items
- **Žádné ranní rozhodnutí** „co se starým otevřeným úkolem" (reissue / escalate / drop / keep)
- **Žádný `daily_decision` audit log** — nelze zpětně zjistit, proč byl task ráno přeskočen
- **Žádný UI signal** „toto je 5. den co čekám na odpověď"
- **Existuje jen** TaskFrameBadge štítek (overdue/stale/k archivaci) + manuální Cleanup tlačítko

---

## E. CRISIS LAYER PLACEMENT AUDIT

| Surface | Co tam dnes z crisis layer žije | Správně? |
|---|---|---|
| **`CrisisAlert` sticky banner** | minimální signal: name / severity / state / dni / stale hours / „Detail" toggle | ✅ **správně** — odpovídá Crisis Reprogram Plan rolím (signal-only) |
| **`KarelOverviewPanel` BLOCK A2 = `KarelCrisisDeficits`** | Karlovy rozhodovací deficity (chybí interview / feedback / stale) | ✅ **správně** — decision deck bez workflow |
| **`DidDashboard` BLOCK 1 = `CommandCrisisCard`** | command-style operativní karta s 2 CTA + Sheet detail | ✅ **správně umístěno** v Operativě, ale **duplicate s deficity** (BLOCK A2 ukazuje „chybí dnešní hodnocení", A4 to samé jako řádek „Dnes chybí: …") |
| **`DidDashboard` „Dnes" sekce → `DidDailySessionPlan`** | crisisWithTodayPlan / crisisWithoutTodayPlan blok (červený border) | ✅ **správně** — to je session execution context, ne crisis ownership |
| **Chat view (`DidContentRouter`)** | mini „⚠ AKTIVNÍ KRIZE" hint nad chatem (jen když submode=cast a aktivní část je v krizi) | ✅ **správně** — derived hint, ne paralelní owner |
| **`DidSprava → Krize` tab** | `DidCrisisPanel` v admin dialogu | ⚠ **mírný leak** — admin gateway by neměl být primární crisis surface. Banner + Pracovna deficity + CommandCrisisCard pokrývají všechno, co je třeba. Tento tab je legacy entry point. |
| **„Otevřít detail" — 2 různé Sheety:** `CrisisDetailWorkspace` (z banner+deficits) vs `DidCrisisPanel` (z CommandCrisisCard) | dvě různé pracovní plochy pro stejný účel | ❌ **misplaced ownership** — Crisis Reprogram Plan říká „společný owner = useCrisisDetail()". CommandCrisisCard otvírá `Sheet` s `DidCrisisPanel`, ne `CrisisDetailWorkspace`. **To je rozpor.** |
| **`Komunikace` surface** | nic crisis-specific | ✅ správně — není to klinická vrstva |
| **`Porady` flow** | `crisis` typ deliberation existuje, ale není tam dedikovaný „crisis room" | ✅ — porady jsou koordinace, ne ownership crisis |

**Crisis verdict:** Po reprogram passu (2026-04-21) je signal layer (banner) + decision layer (deficity v Karlově přehledu) + command layer (CommandCrisisCard) + execution context (session plan) jasně oddělené. **Hlavní zbývající problém:** dva různé „detail" Sheety (CrisisDetailWorkspace vs DidCrisisPanel) podle vstupního bodu. Druhý lifecycle leak je `DidSprava → Krize` tab jako paralelní legacy entrance.

---

## ZÁVĚREČNÉ 3 SEZNAMY

### 1. Co je správně a má zůstat

- ✅ **`KarelOverviewPanel`** jako decision deck (briefing + therapist state + part state + crisis deficity) — single source of Karlova hlasu
- ✅ **`DidDailyBriefingPanel`** jako jediný owner Karlova denního briefingu (po Surface Split 2026-04-20)
- ✅ **`KarelCrisisDeficits`** v Karlově přehledu — decision-only, žádný workflow (po Crisis Reprogram 2026-04-21)
- ✅ **`CommandCrisisCard`** jako command-style karta v Dashboardu — derived ze `snapshot.command.crises`
- ✅ **`TeamDeliberationsPanel`** jako jediný coordination layer (porady) v Dashboardu
- ✅ **`DidDailySessionPlan`** jako jediný session planning + execution panel
- ✅ **`CrisisAlert`** jako jediný signal banner (canonical přes `useCrisisOperationalState`)
- ✅ **`DidContentRouter` flow state machine** — drží sub-routes čistě oddělené (chat / meeting / live / kartoteka / pin-entry)
- ✅ **`useOperationalInboxCounts`** — má sanity guards (HARD_COUNT_CAP, VISIBLE_TASK_WINDOW_DAYS)
- ✅ **`useCrisisOperationalState`** jako canonical view-model pro krize
- ✅ **Idempotence briefing → deliberation** přes `linked_briefing_item_id`

### 2. Co je legacy / duplicate / misplaced

- ⚠ **`KarelDailyPlan`** (1575 LOC) — half-monolit s dvěma režimy (briefing + backlog). Drží 5-odstavcový narrativ paralelně k `DidDailyBriefingPanel`, jen guarded `hideDuplicateBlocks`. Také obsahuje task lists, message-to-therapist boxy, decisions, unclear, sezení sekci — všechny mají jiné canonical místo. **Kandidát na rozdělení / odlehčení.**
- ⚠ **3 paralelní task surfaces bez shared lifecycle:** `did_therapist_tasks` (KarelDailyPlan), `did_pending_questions` (PendingQuestionsPanel ve Správě), briefing.ask_hanka/ask_kata (read-only stringy v briefingu) — **3 surfaces, 2 tabulky, 0 lifecycle**.
- ⚠ **Žádný daily decision pro staré open items** — pendings se tichou akumulací jen vrší, dokud někdo manuálně neklikne Cleanup. Žádný `lifecycle_state`, žádný `daily_decision` log.
- ⚠ **Crisis „detail" má 2 různé komponenty** podle vstupního bodu: `CrisisDetailWorkspace` (banner/deficity) vs `DidCrisisPanel` (CommandCrisisCard Sheet). Single owner claim není dotažený.
- ⚠ **`DidSprava → Krize` tab** = legacy paralelní entry point pro crisis detail. Po reprogram passu redundantní.
- ⚠ **`OpsSnapshotBar` bez akce** — počty bez klik, hraničí s technickým inspect prvkem v Operativě.
- ⚠ **`WorkflowButton`s v Pracovně sekci 3** = duplicita s `CommunicationSurface` (4 stejné buttony 2× v UI).
- ⚠ **`AdminSurface` jako prázdná mapa** — tab existuje, ale jen ukazuje text „jdi do Pracovny → Správa". Inverze. Admin tooly by tam měly opravdu žít, ne odkazovat zpět do Pracovny.
- ⚠ **`DidSprava` Dialog otevíraný z Pracovny** = 21 tabů admin tooling 1 click pod hlavní pracovní plochou.
- ⚠ **`KarelDailyPlan` přímý SQL na 7 tabulek** + vlastní crisis fallback (`fallbackCrisisPart`) — částečně paralelní resolver vůči `useCrisisOperationalState` / snapshot.

### 3. Co bude patřit do Slice 2 — RE-ANCHOR SPEC

Slice 2 musí specifikovat (bez kódových změn):

1. **Unified daily task lifecycle model**
   - jeden `lifecycle_state` enum napříč `did_therapist_tasks` + `did_pending_questions` (nebo per-table parallel + shared view)
   - definovat min. 8 stavů: `new_today` / `waiting_response` / `needs_reissue` / `escalate_to_meeting` / `scheduled_for_session` / `done` / `dropped` / `not_relevant_anymore`
   - definovat ranní decision job (automatický nebo Karel-asistovaný v daily-cycle), který za každý starý open item rozhodne action

2. **Strict ownership model přesně 5 vrstev** (každý blok dostane právě jednu)
   - **Karlův přehled** = decision deck only (briefing + foundation + deficits)
   - **Operativa dne** = active execution / queue layer (today plans, deliberations, ops bar, command crisis card)
   - **Porady** = coordination (TeamDeliberations + DeliberationRoom)
   - **Session planning** = planning + approval (DidDailySessionPlan + briefing.proposed_session pipe)
   - **Admin / Inspect** = mimo hlavní denní decision plochu (skutečně přesunout do AdminSurface, ne nechat v Pracovně header)

3. **Karlův přehled filter contract**
   - explicitně co tam patří: jen položky s `lifecycle_state ∈ { new_today, needs_reissue, escalate_to_meeting }` + dnešní krizové deficity + dnes přicházející odpovědi
   - explicitně co tam nepatří: celý backlog, waiting items bez dnešní relevance, technický inspect, scheduled_for_session, done, dropped

4. **`KarelDailyPlan` rozhodnutí**
   - úplně rozpustit (briefing + DidDailySessionPlan + nový lifecycle UI pokrývají vše)
   - nebo přejmenovat na čistý „Operativní backlog" panel bez briefing-mode větve a bez vlastního `fallbackCrisisPart` resolveru

5. **Crisis detail single-owner enforcement**
   - jeden Sheet (`CrisisDetailWorkspace`) napojený na `useCrisisDetail`
   - `CommandCrisisCard.OtevřítDetail` musí volat `openCrisisDetail()`, ne nezávislý `<Sheet><DidCrisisPanel /></Sheet>`
   - `DidSprava → Krize` tab odstranit nebo přesměrovat na `openCrisisDetail()`

6. **Pracovna dekontaminace**
   - odstranit duplicitní `WorkflowButton`s sekci 3 (Komunikace surface je drží)
   - přesunout `DidSprava` dialog launcher z Dashboard hlavičky pouze do AdminSurface
   - AdminSurface se musí stát skutečnou hostitelskou plochou pro admin tools, ne jen mapou

7. **OpsSnapshotBar rozhodnutí**
   - buď zrušit (counters bez akce demotivují), nebo udělat každý čítač klikatelný do správné sekce (např. „Otázky → Karlův přehled / needs_reissue filter")

8. **Visible vs invisible state contract**
   - definovat: které Karlovy interní stavy (foundation, snapshot, briefing) jsou viditelné v UI a které čistě v WM
   - aktuálně intelligence-driven jsou jen 3 bloky (KarelOverviewPanel, KarelCrisisDeficits, CommandCrisisCard) — operating model F3+F4 nárokuje víc napojení v therapist/part oblasti

---

## Stručné shrnutí (pro odpověď v chatu)

1. **3 hlavní bloky jsou plně intelligence-driven** (KarelOverviewPanel, KarelCrisisDeficits, CommandCrisisCard) — odpovídají Operating Model F3/F4/F7.
2. **`KarelDailyPlan` (1575 LOC)** drží paralelní voice generator a 3 task surfaces bez shared lifecycle — největší zdroj duplikace v Pracovně.
3. **Žádný unified daily task lifecycle** přes tasks + questions + waiting items. Staré open items se tiše vrší. Žádný ranní decision (`reissue` / `escalate` / `drop` / `keep`).
4. **Crisis layer placement je z 90 % správně** po reprogram passu (banner = signal, deficity = decision, CommandCrisisCard = command, SessionPlan = execution). Zbývající problém: dva různé „detail" Sheety + legacy `DidSprava → Krize` tab.
5. **Admin tooling je inverzně umístěn** — `DidSprava` Dialog visí z Pracovny header, `AdminSurface` tab je jen prázdná mapa odkazující zpět.
6. **Duplicity:** Workflow buttons 2× (Pracovna sekce 3 + Komunikace), task surfaces 3×, ask_hanka × KarelDailyPlan tasks × PendingQuestionsPanel.
7. **Slice 2 musí specifikovat:** unified lifecycle model, strict 5-layer ownership, Karlův přehled filter contract, crisis detail single-owner enforcement, KarelDailyPlan dispozici (rozpustit / odlehčit), OpsSnapshotBar rozhodnutí.
