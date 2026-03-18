

# Audit DID režimu — nalezené problémy a plán oprav

## 1. PRÁZDNÝ BLOK "DID dashboard" V UI

**Co je špatně:** V `DidDashboard.tsx` (řádky 143–163) je prázdný kontejner s nadpisem "DID dashboard" a tlačítkem `DidSessionPrep`. Kontejner nemá žádný smysluplný obsah — jen sync progress bar, který se zobrazí pouze při manuální aktualizaci. Působí jako prázdná sekce na dashboardu.

**Jak se to projevuje:** Uživatel vidí prázdný box s nadpisem "DID dashboard" bez obsahu, který vizuálně zabírá místo mezi "Karlův přehled" a "Úkoly pro terapeutky". Tlačítko "Příprava na sezení" je schované v tomto prázdném bloku.

**Oprava:** Odstranit celý blok (řádky 143–163). Přesunout `DidSessionPrep` do hlavičky `DidSystemOverview` (vedle tlačítka "Obnovit").

---

## 2. GARBAGE ÚKOLY V DATABÁZI (assigned_to = "Karel")

**Co je špatně:** V tabulce `did_therapist_tasks` je 8 úkolů přiřazených **"Karel"** (ne terapeutce). Tyto úkoly vytvořila edge funkce `karel-memory-mirror` (source: `mirror_auto`), která nemá validaci pole `assigned_to`.

**Konkrétní data v DB:**
- "Monitorovat Haninu emoční vazbu k Tundrupovi" (assigned_to: Karel, category: supervize) — **soukromá countertransference poznámka**
- "Prozkoumat význam 'černé' jako Arthurova 'tajného místa'" (Karel, Analýza)
- "Zvážit, jak podpořit Arthura v komunikaci" (Karel, Komunikace)
- "Zajistit, aby Káťa byla informována" (Karel, Koordinace týmu)
- "Navrhnout Káťě konkrétní hru" (Karel, DID_terapie)
- "Konzultovat s Hanou možnosti neverbálních technik" (Karel, DID_terapie)
- "Připravit se na záznam o Dymim" (Karel, DID_management)
- "Vytvořit detailní kartu pro Clark" (Karel, DID_management)

**Proč se to stalo:** `karel-memory-mirror/index.ts` řádek 504 zapisuje `assigned_to: task.assigned_to || "both"` bez validace, zda je to terapeutka. AI model vygeneroval úkoly s `assigned_to: "Karel"`, a backend je bez kontroly uložil.

**Jak se to projevuje:** Frontend (`DidTherapistTaskBoard.tsx` řádek 339) tyto úkoly **filtruje** pomocí `isTherapistAssignee()`, takže nejsou viditelné na nástěnce. Ale jsou v DB, znečišťují data, a hlavně obsahují **soukromé countertransference informace**, které by nikdy neměly být v tabulce úkolů.

**Oprava:**
1. SQL migrace: smazat úkoly kde `assigned_to NOT IN ('hanka', 'kata', 'both')`
2. `karel-memory-mirror/index.ts`: přidat validaci `assigned_to` před insertem — pokud není `hanka/kata/both`, nepsat úkol
3. `TaskSuggestButtons.tsx`: přidat stejnou validaci v `handleSave`

---

## 3. NEVALIDNÍ KATEGORIE ÚKOLŮ

**Co je špatně:** Memory mirror generuje úkoly s kategoriemi jako "supervize", "Koordinace týmu", "DID_terapie", "DID_management", "Komunikace", "Analýza", "Péče o část". Frontend ale rozpozná pouze `today`, `tomorrow`, `longterm`, `general`, `weekly`, `daily`.

**Jak se to projevuje:** Úkoly s neznámou kategorií spadnou do sekce "Dlouhodobé" díky fallbacku v `isLongtermCategory()` (řádek 122), ale zobrazují nesmyslné štítky kategorií.

**Oprava:** V `karel-memory-mirror` normalizovat kategorii na povolené hodnoty (`today`/`tomorrow`/`longterm`) nebo nastavit `general` jako default.

---

## 4. NEVALIDNÍ PRIORITA ÚKOLŮ

**Co je špatně:** Memory mirror generuje priority jako "Vysoká" a "Střední" (česky), ale frontend používá `high`, `normal`, `low` (anglicky).

**Jak se to projevuje:** Funkce `priorityLabel()` (řádek 124) nezná české hodnoty, a zobrazí fallback "Nízká" pro jakoukoliv neznámou hodnotu.

**Oprava:** V `karel-memory-mirror` normalizovat priority na `high`/`normal`/`low`.

---

## 5. `syncOverviewTasksToBoard` JE MRTVÝ KÓD

**Co je špatně:** `src/lib/parseOverviewTasks.ts` exportuje funkci `syncOverviewTasksToBoard()`, ale **nikde v celé aplikaci není volána**. Byla zřejmě odpojena při refactoru.

**Jak se to projevuje:** Úkoly z Karlova přehledu se **neparsují** a **nesynchronizují** na nástěnku při zobrazení overview. Úkoly, které Karel doporučí v přehledu, se nikam nezapisují.

**Oprava:** Buď integrovat volání `syncOverviewTasksToBoard(overview)` do `DidSystemOverview.tsx` po úspěšném načtení přehledu, nebo pokud to není žádoucí, smazat mrtvý kód.

---

## 6. DidCountertransferenceMap EXISTUJE ALE NENÍ ZOBRAZENA

**Co je špatně:** Komponenta `DidCountertransferenceMap.tsx` existuje, ale **není importována ani renderována** nikde na dashboardu. Byla zřejmě odstraněna z `DidDashboard.tsx` při předchozím refactoru.

**Poznámka:** Toto může být záměrné — countertransference data by neměla být viditelná v UI (dle memory `karluv-prehled-systemu`). Pokud je to záměrné, soubor by měl být smazán. Pokud ne, měl by být vrácen do dashboardu.

---

## SHRNUTÍ ODCHÝLENÍ OD ZÁMĚRU

| Problém | Závažnost | Příčina |
|---------|-----------|---------|
| Prázdný "DID dashboard" blok | Střední | Nedokončený refactor UI |
| 8 garbage úkolů pro "Karel" v DB | Vysoká | Chybějící validace v memory-mirror |
| Soukromé countertransference v task tabulce | Kritická | Dtto |
| Neplatné kategorie/priority úkolů | Nízká | Mirror generuje české hodnoty místo kódů |
| Mrtvý kód parseOverviewTasks | Střední | Odpojeno při refactoru, nikdy znovu zapojeno |
| Countertransference mapa nezobrazena | Informativní | Záměrné nebo nedopatření |

---

## PLÁN OPRAV

### Krok 1: Vyčistit DB (SQL migrace)
```sql
DELETE FROM did_therapist_tasks 
WHERE assigned_to NOT IN ('hanka', 'kata', 'both');
```

### Krok 2: Opravit `karel-memory-mirror/index.ts`
- Před insertem úkolu (řádek ~501): validovat `assigned_to` ∈ {hanka, kata, both}, jinak skip
- Normalizovat `category` na `today/tomorrow/longterm`
- Normalizovat `priority` na `high/normal/low`

### Krok 3: Opravit `TaskSuggestButtons.tsx`
- V `handleSave`: přidat guard `if (!["hanka","kata","both"].includes(suggestion.assignee)) return`

### Krok 4: Odstranit prázdný "DID dashboard" blok
- Smazat řádky 143–163 v `DidDashboard.tsx`
- Přesunout `DidSessionPrep` do `DidSystemOverview.tsx` (vedle "Obnovit")

### Krok 5: Rozhodnout o `syncOverviewTasksToBoard`
- Znovu napojit na `DidSystemOverview` po načtení overview, NEBO smazat mrtvý kód

### Krok 6: Rozhodnout o `DidCountertransferenceMap`
- Smazat soubor (pokud záměrně odstraněna z UI), nebo vrátit do dashboardu

### Soubory k úpravě:
1. `src/components/did/DidDashboard.tsx`
2. `src/components/did/DidSystemOverview.tsx`
3. `src/components/did/TaskSuggestButtons.tsx`
4. `supabase/functions/karel-memory-mirror/index.ts`
5. SQL migrace (smazání garbage úkolů)
6. Volitelně: `src/lib/parseOverviewTasks.ts`, `src/components/did/DidCountertransferenceMap.tsx`

