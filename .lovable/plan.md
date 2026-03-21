

# Porovnání: Systémová instrukce vs. aktuální implementace

## ČÁST 1 – ARCHITEKTURA ÚLOŽIŠŤ

### ✅ Co už funguje
- **Google Drive struktura**: 00_CENTRUM, KARTOTEKA, 05_PLAN, 06_INTERVENCE, 07_DOHODY, 09_KNIHOVNA – vše existuje a Karel s tím pracuje
- **Supabase DB**: vlákna (`did_threads`), úkoly (`did_therapist_tasks`), pending záznamy (`did_pending_drive_writes`), sezení (`did_part_sessions`)
- **PAMET_KAREL**: profilace terapeutek (HANKA, KATA podsložky) – Karel čte i zapisuje
- **Deduplikace úkolů**: Karel kontroluje duplicity před přidáním

### ⚠️ Co je jinak
- **DID_Therapist_Tasks – 4 listy (Operativní, Taktické, Strategické, Archiv)**: Aktuálně Karel píše do JEDNOHO listu (první sheet). Instrukce vyžaduje 4 oddělené listy s různými sloupci a logikou. Toto je velká mezera.
- **Max 3 aktivní úkoly na terapeuta**: Logika existuje v promptu (`systemPrompts.ts`), ale sync-therapist-tasks nefiltruje ani nevynucuje limit při zápisu do sheetu.
- **Automatický přesun po 14 dnech do Archivu**: Neexistuje. Karel archivuje manuálně nebo přes „Vyčistit úkoly" (po 7 dnech).
- **Sloupce listu Operativní**: Aktuální sheet má 11 sloupců (ID, CAST_ALTER, KDO, UKOL, ZDROJ_ODKAZ, DO_KDY, STATUS, PRIORITA, POZNAMKA, DATUM_VYTVORENI, DATUM_SPLNENI). Instrukce chce: ID, Komu, Úkol, Detail(odkaz), Priorita(1/2/3), Stav, Datum, Deadline, Část, Poznámka – drobné odchylky.

---

## ČÁST 2 – AKTUALIZACE KARTOTÉKY (manuální Mirror)

### ✅ Co už funguje
- **KROK 0 – Příprava**: Karel načítá karty z Drive, čte nezpracovaná vlákna, AI třídí podle sekcí A–M (Protokol v2)
- **Sekce A–M**: Implementováno v AI promptu s `[SEKCE:X:REPLACE]` a `[SEKCE:X]` tagy
- **Sekce B – Povinná profilace**: MBTI, IQ/EQ, archetypy, terapeutické přístupy – vynuceno v promptu
- **Sekce D – Perplexity rešerše**: Nově implementováno (per-část Perplexity volání po AI Pass 2)
- **Sekce G – Deník**: Podmíněný zápis jen na žádost části
- **REPLACE vs APPEND logika**: A,B,C,D,F,J,L,M = REPLACE; E,G,H,I,K = APPEND
- **Označení zpracovaných vláken**: Nově implementováno (`is_processed=true`)
- **KHASH deduplikace**: Funguje
- **Semantic dedup**: AI-powered kontrola duplicit

### ⚠️ Co je jinak / chybí
- **Pending záznamy z denních plánů sezení (bod 4 KROK 0)**: Karel zpracovává `did_pending_drive_writes` v daily-cycle, ale Mirror je NEČTE a nezapracovává do karet. Instrukce říká, že Mirror by měl zapracovat pending záznamy ze starých plánů sezení do sekcí E + J.
- **Sekce C – granulární logika**: Instrukce říká „najdi bod nejméně odpovídající → odstraň → nahraď". Karel to dělá přes REPLACE celé sekce, ne bod po bodu. Prakticky ekvivalentní, ale méně precizní.
- **Sekce D – zápis do listu Taktické**: Instrukce říká, že nová technika v sekci D se má zapsat i do listu Taktické v DID_Therapist_Tasks. Karel to nedělá (zapisuje jen do `did_therapist_tasks` DB tabulky, ne do specifického listu).
- **Sekce H – aktualizace listu Strategické**: Instrukce říká, že dosažený cíl se má projevit i v listu Strategické. Neexistuje.
- **Sekce I – psychoanalytický rozbor per klíčový prvek**: Instrukce vyžaduje pro KAŽDÝ klíčový prvek z vlákna navrhnout aktivitu s názvem, cílem, postupem, pomůckami, zdůvodněním, doporučeným terapeutem, horizontem. Karel to dělá obecněji (ne takto strukturovaně per prvek).
- **ZÁVĚREČNÝ KROK – notifikace**: Instrukce říká, že pokud analýza vyžaduje okamžitou pozornost → odešli mail/zprávu. Karel aktuálně neposílá urgentní notifikace z Mirror jobu.

---

## ČÁST 3 – DENNÍ TERAPEUTICKÝ PLÁN (automaticky 14:00)

### ✅ Co funguje (částečně)
- **`karel-did-session-prep`**: Existuje a generuje 60min plán sezení s konkrétními aktivitami, triggery, tipy
- **Perplexity rešerše pro sezení**: Karel hledá terapeutické techniky
- **Drive data**: Čte kartu části, operativní plán, dohody, dashboard
- **Dormancy guard**: Karel rozlišuje spící vs. aktivní části
- **PAMET_KAREL čtení**: Karel čte profily terapeutek pro personalizaci

### ❌ Co KOMPLETNĚ CHYBÍ
- **Automatické spuštění ve 14:00**: `karel-did-session-prep` je čistě manuální (terapeut si ho vyžádá z UI). NEEXISTUJE automatický cron job, který by každý den ve 14:00 vybral část a sestavil plán.
- **SKÓRE NALÉHAVOSTI**: Neexistuje žádná implementace bodovacího systému (krizový stav +5, noční můry +4, atd.). Session prep přijímá `partName` jako vstup od terapeuta – Karel NEVYBÍRÁ sám.
- **Distribuce plánu**: 
  - Drive zápis do 05A_Operativni_Plan: NEFUNGUJE automaticky
  - Připnutá karta v „Karlův přehled": NEEXISTUJE takové UI okno
  - Denní mail s plánem: Mail se posílá z `karel-did-daily-email`, ale NEOBSAHUJE plán sezení
  - Zápis do DID_Therapist_Tasks: session-prep NEvytváří úkoly v sheetu
- **Formát A/B pro Káťu**: Karel to navrhuje v promptu session-prep, ale NEdistribuuje oddělené instrukce Káti mailem
- **Udržovací plán**: Pokud žádná část nebyla 48h aktivní → instrukce říká sestavit obecný stabilizační plán. Neimplementováno.
- **Propojení se Střednědobým plánem (list Taktické)**: Neexistuje

---

## ČÁST 4 – SLEDOVÁNÍ SEZENÍ A ZPĚTNÁ VAZBA

### ❌ KOMPLETNĚ CHYBÍ

- **FÁZE 2 – Poradenský mód**: Když terapeut označí úkol jako „Probíhá", Karel by měl přepnout do režimu odborného asistenta (ne odpovídat jako část). Toto NEEXISTUJE jako automatický trigger. Karel odpovídá v chatovém kontextu podle sub_mode, ne podle stavu úkolu.
- **Časový monitoring sezení (75 min reminder)**: Neexistuje.
- **FÁZE 3 – Aktivní follow-up**: Karel NEČEKÁ 2 hodiny po sezení a NEPOSÍLÁ automatické dotazy na zpětnou vazbu. Neexistuje žádný cron/scheduled job pro follow-up.
- **24h timeout → ⚠️ Nesplněno**: Neexistuje automatické označení po 24h.
- **FÁZE 4 – Zpracování zpětné vazby**:
  - Pending záznamy pro kartu (E, J, B): Částečně – `did_pending_drive_writes` existuje, ale není napojeno na flow zpětné vazby ze sezení
  - Aktualizace DID_Therapist_Tasks (3 listy): Neexistuje multi-sheet logika
  - **PAMET_KAREL – Profil terapeuta po sezení**: Karel zapisuje profily terapeutek z Mirror/daily-cycle, ale NE strukturovaný záznam per sezení (Plán dodržen: ano/ne, Aktivita provedena: ano/ne, atd.)
  - **Sledování trendů spolupráce** (3× neoznačeno → upozornění): Neexistuje
  - **Aktualizace „Karlův přehled"**: UI okno neexistuje

---

## ČÁST 5 – OBECNÁ PRAVIDLA

### ✅ Co funguje
- Karel nehodnotí terapeutky negativně (v promptech)
- Karel nikdy nezahájí zpracování traumatické vzpomínky bez ověřené stability (v session-prep promptu)
- Karel v chatovém kontextu rozlišuje sub_mode (cast vs. mamka/kata)
- Ochranné filtry (blacklist biologických osob)
- Zákaz dechových cvičení (epilepsie)

### ❌ Co chybí
- **Konzistentní kontrola dat** mezi kartou, DID_Therapist_Tasks a 05A: Neexistuje automatická kontrola konzistence
- **Udržovací plán při 48h neaktivitě**: Neexistuje

---

## SOUHRNNÁ TABULKA

```text
Funkce                              Stav
────────────────────────────────── ──────────
Drive struktura (CENTRUM, karty)    ✅ Hotovo
Aktualizace kartotéky (Mirror)      ✅ 85% (chybí pending záznamy, notifikace)
Protokol v2 (REPLACE/APPEND)        ✅ Hotovo
Perplexity rešerše per-část         ✅ Hotovo
Thread marking                      ✅ Hotovo
Task sync do sheetu                 ✅ Hotovo (1 list)
4 listy v DID_Therapist_Tasks       ❌ Chybí (jen 1 list)
Auto denní plán sezení 14:00        ❌ Chybí kompletně
Skóre naléhavosti + výběr části     ❌ Chybí kompletně
Distribuce plánu (mail+Drive+UI)    ❌ Chybí kompletně
Poradenský mód při sezení           ❌ Chybí kompletně
Follow-up po sezení (2h+24h)        ❌ Chybí kompletně
Zpracování zpětné vazby             ❌ Chybí kompletně
Profil terapeuta per sezení         ❌ Chybí (existuje obecný profil)
Sledování trendů spolupráce         ❌ Chybí kompletně
UI "Karlův přehled" (připnuté)      ❌ Chybí kompletně
Konzistence karta↔sheet↔plán        ❌ Chybí kompletně
```

## ZÁVĚR

Karel má solidní základ pro **Část 1** (úložiště) a **Část 2** (aktualizace kartotéky – cca 85%). Hlavní mezery jsou v **Částech 3 a 4** – celý životní cyklus sezení (automatický výběr části, sestavení plánu, distribuce, poradenský mód, follow-up, zpětná vazba) je buď manuální, nebo zcela chybí. Nejzásadnější chybějící komponenty:

1. **Automatický denní plán sezení** (cron 14:00 + skóre naléhavosti + výběr části)
2. **4-listový DID_Therapist_Tasks** (Operativní/Taktické/Strategické/Archiv)
3. **Follow-up cyklus** (2h check + 24h timeout + zpětná vazba → pending záznamy)
4. **Poradenský mód** (auto-switch při probíhajícím sezení)
5. **UI „Karlův přehled"** (připnuté karty sezení se stavy)

