

# Diagnostika: Jak Karel reálně pracuje s plánem, profilací a strategií

## Tvrdá fakta z databáze a kódu

### 1. Terapeutický plán — kde žije a kdo ho čte

Karel má **3 vrstvy plánu**, ale jejich propojení je **jednosměrné a neúplné**:

| Vrstva | Umístění | Kdo zapisuje | Kdo čte | Problém |
|--------|----------|-------------|---------|---------|
| **05_Operativni_Plan** | Google Drive, 00_CENTRUM | Denní cyklus (přepis) | `karel-chat` (max 3000 znaků) | ✅ Funguje — ale denní cyklus dnes padá |
| **06_Strategicky_Vyhled** | Google Drive, 00_CENTRUM | Týdenní cyklus | `karel-did-session-prep` | ⚠️ Týdenní cyklus selhává — dokument neaktualizován |
| **did_system_profile** | DB tabulka | Nikdo automaticky | `karel-did-session-prep` | ❌ **Tabulka je PRÁZDNÁ** (0 řádků). Nikdo ji neplní. |

**Závěr**: `did_system_profile` (cíle, priority, riziková faktory, integrační strategie) **je prázdná**. Session prep, weekly cycle a monthly cycle z ní čtou `goals_short_term`, `goals_mid_term`, `goals_long_term` — ale dostávají **prázdná pole**. Karel tedy nemá v DB žádné cíle, proti kterým by mohl měřit pokrok.

### 2. Profilace terapeutek — jak Karel používá PAMET_KAREL

**Kde se čte**: 
- `karel-chat/index.ts` řádky 50-120: Při každém rozhovoru v režimu mamka/kata Karel načte z Drive `00_Aktualni_Dashboard` (max 4000 znaků) a `05_Operativni_Plan` (max 3000 znaků). Injektuje je do system promptu jako „KARLOVY VLASTNÍ DEDUKCE".
- `karel-did-session-prep`: Čte `PAMET_KAREL/DID/[HANKA|KATA]/` — hledá soubory s `STRATEGIE`, `SITUACNI`, `PROFIL` (max 3 soubory, 1500 znaků každý).
- `karel-did-context-prime`: Toto je hlavní „situační cache" — ale **nečte PAMET_KAREL přímo**, čte jen kartotéku.

**Kde se zapisuje**:
- `karel-memory-mirror` (Zrcadlit do Drive) — extrahuje profilační data z konverzací a zapisuje do PAMET_KAREL.
- `karel-did-daily-cycle` — přepisuje `05_Operativni_Plan`, zapisuje do karet. **Ale nepíše do PAMET_KAREL/DID/HANKA ani KATA**.

**Problém**: Profilace se aktualizuje **pouze** když uživatel manuálně spustí „Zrcadlit do Drive". Denní cyklus profilaci **neaktualizuje**. Karel tedy v chatu čte potenciálně zastaralou profilaci.

### 3. Jak plán vstupuje do úkolů

Tok: `05_Operativni_Plan` → denní cyklus generuje `[ACCOUNTABILITY]` blok → ale **úkoly se na nástěnku nedostávají z denního cyklu přímo**. Úkoly na nástěnku se dostávají:
1. **Z Karlova přehledu** (system-overview) → parsování sekce „Dnes doporučuji" → `syncOverviewTasksToBoard`
2. **Z chatu** → `[TASK_SUGGEST]` tagy → inline tlačítka

**Aktuální stav nástěnky**: **56 nesplněných úkolů** (34 assigned_to=both/high, 21 kata/high, 1 both/normal). Všechny z dnešního dne, všechny `not_started`. Většina jsou **sémantické duplikáty**:
- „Haničko, prověř možnosti navázání komunikace s interním prostředím" — 3× téměř identicky
- „Koordinační check-in" — 5× různé formulace
- „Dormantní iniciativy" — 2×

Fuzzy deduplikace (Jaccard > 0.6) **nefunguje dostatečně** protože formulace jsou různé ale význam stejný. Problém: Jaccard porovnává slova, ne sémantiku.

### 4. Jak Karel cílí aktivitu v aplikaci

**System prompt** (`systemPrompts.ts`) definuje chování staticky:
- Řádky 474-544: „KAREL JAKO AKTIVNÍ VEDOUCÍ TÝMU" — instrukce k proaktivnímu dotazování, eskalaci, poradám
- Řádky 496-502: Na začátku rozhovoru se zeptej na stav úkolů
- Řádky 504-509: Adaptační algoritmus — pozoruj reakce, přizpůsobuj styl

**Runtime injekce** (`karel-chat/index.ts` řádky 130-182):
- Načte `did_therapist_tasks` (nesplněné) + `did_motivation_profiles`
- Spočítá poměr splněno/nesplněno, průměr dnů, sérii
- Injektuje do promptu: eskalační upozornění, styl komunikace

**Motivační profily** — aktuální data:
- Hanka: 1 splněný, 0 nesplněných, série 1, styl „balanced"
- Káťa: 1 splněný, 0 nesplněných, série 1, styl „balanced"
- Profily byly vytvořeny 13.3. a od té doby **neaktualizovány** — tzn. Karel nesleduje skutečné plnění.

### 5. Kontrolní mechanismy (accountability)

Kód existuje, ale **nefunguje v praxi**:
- Denní cyklus generuje `[ACCOUNTABILITY]` blok — ale **denní cyklus dnes padá** (status: running od 13:00, předchozí: všechny failed)
- Eskalační logika v `systemPrompts.ts` řádky 521-527: „úkol nesplněn 3+ dny → porada" — ale `escalation_level` je u všech úkolů **0**, nikdo ho neinkrementuje
- Pole `did_therapist_tasks.escalation_level` se nikde v kódu automaticky nezvyšuje — je to mrtvé pole

### 6. Porady — proč chybí v přehledu a úkolech

`karel-did-system-overview` nyní načítá `did_meetings` (po mém předchozím opravě) — řádky 693-695. Ale:
- Data se zobrazují jen v „OTEVŘENÉ PORADY" sekci vstupu pro AI
- AI je zmíní v přehledu pouze pokud jsou otevřené porady v DB
- Problém: **žádný kód nepropojuje výstupy porad (outcome_tasks) zpět do nástěnky úkolů**. Porada se koná, Karel shrne, ale úkoly z porady zůstávají jen v `did_meetings.outcome_tasks` JSON poli.

---

## Co konkrétně nefunguje a proč

1. **`did_system_profile` je prázdná** — žádné cíle, žádná strategie v DB. Session prep a cykly čtou prázdná data.
2. **Denní + týdenní cykly padají** — oba běží v „running" stavu od 13:00/12:42, předchozí všechny failed. Timeout 180s nestačí nebo edge function padá na Drive API.
3. **56 duplicitních úkolů** — Jaccard deduplikace selhává na sémantických parafrázen.
4. **Motivační profily zmrazené od 13.3.** — nikde se neinkrementují `tasks_completed`/`tasks_missed` při změně stavu úkolu.
5. **Eskalace nefunguje** — `escalation_level` nikdy neroste, žádný cron/trigger to neřeší.
6. **Outcome porad se nezapisují do úkolů** — `did_meetings.outcome_tasks` se nikde nečte pro sync do `did_therapist_tasks`.
7. **PAMET_KAREL se neaktualizuje automaticky** — jen manuální „Zrcadlit do Drive".

## Navrhovaný plán oprav (6 kroků)

### Krok 1: Naplnit did_system_profile
Napsat migraci nebo edge function, která jednorázově naplní `did_system_profile` z `06_Strategicky_Vyhled` na Drive (cíle, priority, strategie). Přidat logiku do weekly cycle, aby tabulku aktualizoval.

### Krok 2: Opravit padající cykly
Prozkoumat edge function logy denního a týdenního cyklu. Zvýšit timeout na edge function úrovni. Optimalizovat prompt size (kontext pro AI je příliš velký).

### Krok 3: Sémantická deduplikace úkolů
Nahradit Jaccard matching za normalizaci klíčových frází (odstranit oslovení, filler slova). Smazat 56 duplicitních úkolů. Přidat DB trigger nebo check při insertu.

### Krok 4: Živé motivační profily
Přidat trigger/logiku do `DidTherapistTaskBoard` — při změně stavu úkolu na „done" inkrementovat `tasks_completed` a aktualizovat `streak_current`, `avg_completion_days`, `last_active_at`.

### Krok 5: Automatická eskalace
Přidat do denního cyklu (nebo pg_cron) logiku: pro každý úkol starší 4 dnů s `status != done` inkrementovat `escalation_level`. Při level 2+ označit jako urgent.

### Krok 6: Propojit porady → úkoly
Při finalizaci porady (`did_meetings.status = 'finalized'`) automaticky přepsat `outcome_tasks` do `did_therapist_tasks`.

