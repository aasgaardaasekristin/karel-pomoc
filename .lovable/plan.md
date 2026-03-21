

# Analýza: Co Karel dělá vs co MÁ dělat s kartami

## STAV AKTUÁLNÍHO KÓDU

### 1. Jak aktuálně probíhá "Aktualizace kartotéky" (daily-cycle)

Denní cyklus (`karel-did-daily-cycle`) dělá toto:
1. Načte vlákna (did_threads) za posledních 24h
2. Načte karty zmíněných částí z Drive
3. Pošle vše do AI (Gemini 2.5 Flash) s promptem obsahujícím "MAPU ROZHODOVÁNÍ" (sekce A-M)
4. AI vrátí `[KARTA:jméno][SEKCE:X]...[/KARTA]` bloky
5. Kód tyto bloky parsuje a **APPENDUJE** obsah do existujících sekcí přes `updateCardSections()`

### 2. Klíčové ROZDÍLY oproti požadovaným instrukcím

---

#### A) KROK 0 – PŘÍPRAVA (CHYBÍ)

**Požadavek:** Karel musí nejdřív přečíst CELÉ vlákno, vytvořit si interní pracovní poznámky roztříděné podle sekcí A-M, a teprve pak začít aktualizovat.

**Realita:** AI dostane surové konverzace + existující karty a generuje výstup najednou. Chybí explicitní fáze „přípravné třídění".

**Oprava:** Přidat do AI promptu explicitní instrukci pro KROK 0 – nejdřív vytvořit `[PŘÍPRAVA:jméno]` blok s roztříděnými poznámkami, teprve pak `[KARTA:...]` bloky. Toto je čistě prompt-level změna.

---

#### B) SEKCE A – "NAHRADIT" vs "APPENDOVAT"

**Požadavek:**
- a) Datum a aktuální stav se NAHRAZUJE (ne appenduje)
- b-d) Podvědomí, vztahy, ochranné mechanismy se DOPLŇUJÍ s validací rozporů

**Realita:** Kód VŽDY appenduje (`existing + "\n\n" + timestamped`). Nikdy nenahrazuje existující text.

**Oprava:** Potřeba nový MODE v `update-card-sections` – "replace-section" pro sekci A (odstavec aktuální stav). Alternativně: AI dostane explicitní instrukci generovat KOMPLETNÍ sekci A (ne jen doplněk) a kód ji celou přepíše.

---

#### C) SEKCE B – Psychologická profilace (ČÁSTEČNĚ CHYBÍ)

**Požadavek:**
- Aktuální stav: odstraň 3 nejstarší body, přidej 3 nové
- Psychologické charakteristiky: hodnoť % shodu, nahraď nejméně odpovídající
- **Psychologická profilace osobnosti** (POVINNÁ): rozsáhlý profil (MBTI, IQ, EQ, archetypy, vhodné profese...)
- Obranné mechanismy: stejný % princip

**Realita:** Prompt zmiňuje sekci B jen stručně: "Psychologické charakteristiky, obranné mechanismy, jak reaguje na kontakt". Neobsahuje instrukci pro:
- Rotaci bodů (odstraň 3 nejstarší, přidej 3 nové)
- % hodnocení shody
- Povinnou psychologickou profilaci
- Kód nemá logiku pro NAHRAZENÍ jednotlivých bodů – jen appenduje

**Oprava:** Významná úprava promptu v daily-cycle + nová logika v kódu pro "smart merge" (ne jen append).

---

#### D) SEKCE C – Rotace bodů (CHYBÍ)

**Požadavek:** Pro každý odstavec (potřeby, strachy, triggery, konflikty, rizika): najdi nejméně odpovídající bod, odstraň, nahraď novým.

**Realita:** Prompt říká "Nenaplněné potřeby a hluboké strachy" ale nedává instrukci pro rotaci. Kód jen appenduje.

---

#### E) SEKCE D – Internet rešerše (ČÁSTEČNĚ)

**Požadavek:** Karel prohledá internet a najde vhodné terapeutické techniky; nalezené techniky zapíše i do operativního plánu.

**Realita:** Perplexity rešerše EXISTUJE (sonar-pro), ale je obecná pro všechny části najednou. Chybí cílená rešerše per-část. Zápis do operativního plánu existuje přes `[CENTRUM:05_Operativni_Plan]` blok.

---

#### F) SEKCE F – Audit zastaralých dat (CHYBÍ)

**Požadavek:** Odstraň věty s uplynulým datem/relevancí.

**Realita:** Kód nikdy neodstraňuje data – jen appenduje. AI prompt neobsahuje instrukci pro mazání zastaralých záznamů.

---

#### G) SEKCE G – Deník části (ČÁSTEČNĚ)

**Požadavek:** Pouze pokud si část VÝSLOVNĚ přála zapsat do deníku. Text ve stylu 1. osoby, jazyk/styl přizpůsobený části.

**Realita:** Prompt říká "POVINNÉ při KAŽDÉM rozhovoru" – což je v ROZPORU s instrukcí (jen na výslovnou žádost).

---

#### H) SEKCE L – Rotace záznamů (CHYBÍ)

**Požadavek:** Odstraň nejstarší záznam, přidej nový.

**Realita:** Pouze appenduje nový řádek. Nejstarší se nikdy neodstraňuje.

---

#### I) SEKCE M – Validace a mazání (CHYBÍ)

**Požadavek:** Pokud vlákno je v rozporu se směrem poznámek, smaž nerelevantní záznamy.

**Realita:** Pouze appenduje. Nikdy nemaže.

---

#### J) DID_Therapist_Tasks Sheet (NOVÉ)

**Požadavek:** Karel zapisuje úkoly do Google Sheet s formátem:
- ID: `INT-YYYY-MM-DD-X00` (X = první písmeno alteru)
- Sloupce: ID, CAST_ALTER, KDO, UKOL, ZDROJ_ODKAZ, DO_KDY, STATUS, PRIORITA, POZNAMKA, DATUM_VYTVORENI, DATUM_SPLNENI
- 4 listy: Hlavní, Legenda, (2 prázdné rezervní)
- Priority: 🔴 vysoká, 🟡 střední, 🟢 nízká

**Realita:** Karel zapisuje úkoly POUZE do DB tabulky `did_therapist_tasks` (ta má jiné sloupce). Sheet `DID_Therapist_Tasks` na Drive se jen ČTOU pro kontext (daily-cycle, morning-brief) a SYNCHONIZUJÍ jednorázově přes `centrum-sync` (ten ale zapisuje CSV formát neodpovídající sheetu).

**Chybí:** Režim/funkce pro synchronizaci DB úkolů → Drive Sheet ve správném formátu (s ID formátem INT-YYYY-MM-DD-X00).

---

### 3. CO JE SPRÁVNĚ

- ✅ Sekce E (Chronologický log) – appendování záznamů funguje
- ✅ Sekce H (Dlouhodobé cíle) – appendování funguje
- ✅ Sekce I (Terapeutické metody) – appendování + Perplexity rešerše funguje
- ✅ Sekce J (Priority a intervence) – appendování funguje
- ✅ Sekce K (Záznamy ze sezení) – appendování funguje
- ✅ CENTRUM dokumenty – Dashboard, Operativní plán, Strategický výhled – čtení i zápis fungují
- ✅ Registry + card lookup + fail-safe – robustní
- ✅ Sémantická deduplikace (KHASH) – funguje
- ✅ Blacklist biologických osob – funguje
- ✅ Anti-hallucination guard – funguje

---

## PLÁN OPRAV (5 kroků)

### Krok 1: Kompletní přepis AI promptu v daily-cycle (~line 3098-3510)

Nahradit stávající "MAPA ROZHODOVÁNÍ" detailními instrukcemi pro sekce A-M z požadavku:
- KROK 0: Přípravné třídění
- Sekce A: NAHRAZENÍ aktuálního stavu + validace rozporů
- Sekce B: Rotace 3 bodů + % hodnocení + POVINNÁ profilace
- Sekce C: Rotace nejméně odpovídajícího bodu per odstavec
- Sekce D: Cílená rešerše + zápis do operativního plánu
- Sekce F: Audit zastaralých dat
- Sekce G: POUZE na výslovnou žádost části (ne povinně)
- Sekce L: Rotace (odstraň nejstarší)
- Sekce M: Validace + mazání nerelevantních

### Krok 2: Nová logika v `updateCardSections` (drive-write)

Přidat podporu pro "smart merge" – AI může vrátit sekci s příkazem:
- `[SEKCE:A:REPLACE]` = celá sekce se přepíše (pro aktuální stav)
- `[SEKCE:B:ROTATE]` = sekce se inteligentně sloučí (AI už rotaci provedla)
- Výchozí chování zůstává APPEND

### Krok 3: Synchronizace DB → Drive Sheet (DID_Therapist_Tasks)

Nový MODE I v `karel-did-drive-write`: `sync-therapist-tasks`
- Přečte všechny aktivní úkoly z `did_therapist_tasks`
- Zapíše je do Sheetu na Drive ve formátu z požadavku (ID, CAST_ALTER, KDO, UKOL...)
- Generuje ID formát `INT-YYYY-MM-DD-X00`
- Spouští se automaticky po denním cyklu

### Krok 4: Aktualizace `systemPrompts.ts` (kartotekaPrompt)

Doplnit do kartotekaPrompt instrukce odpovídající novému zpracování karet, aby i interaktivní režim (chat s Karlem) pracoval konzistentně.

### Krok 5: Aktualizace centrum-sync

Upravit zápis do `DID_Therapist_Tasks` sheetu tak, aby používal správné sloupce a formát ID.

---

## Doporučený postup

Implementovat v pořadí: Krok 1 (prompt) → Krok 2 (smart merge) → Krok 3 (task sync) → Krok 4 (systemPrompts) → Krok 5 (centrum-sync). Kroky 1+2 jsou jádro opravy; 3-5 jsou rozšíření.

