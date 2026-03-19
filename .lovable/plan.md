

## Oprava sekce „Úkoly pro terapeutky" — 3 bugy + návrh semaforu

### Identifikované problémy

**Bug 1: Filtr Kdo/Kdy nespolehlivý**
Tlačítka filtrů (Hanka/Káťa/Obě, Dnes/Zítra/Dlouhodobé) přepínají mezi hodnotou a `"all"` — ale neexistuje žádné vizuální rozlišení stavu `"all"`. Navíc tlačítka slouží POUZE jako filtr zobrazení, ale `newAssignee`/`newCategory` pro přidání nového úkolu zůstávají vždy na výchozí hodnotě (`both`/`today`). Uživatel si myslí, že filtrováním volí i parametry nového úkolu — ale nevolí. Oprava: synchronizovat filtry s novým úkolem a přidat jasný stav "vše".

**Bug 2: Chybí dvojice semaforů u „Obě"**
Řádek 193-194: pro `assigned_to === "both"` se zobrazí JEDEN agregovaný semafor. Správně mají být DVA — `H` a `K` — každý nezávisle klikatelný.

**Bug 3: Text úkolu neúplný/nesrozumitelný**
Funkce `truncateTitle` v `parseOverviewTasks.ts` ořezává text na 80 znaků a zbytek strčí do `note`. Výsledek: úkol na nástěnce je neúplná věta. Oprava: zvýšit limit na 150 znaků a NEODDĚLOVAT mid-sentence.

### Návrh nahrazení semaforových koleček

Současné kolečka (⚪→🟡→🟢) jsou malá a matoucí. Návrh:

**Textový badge se stavem** — pro každou terapeutku malý chip s jejím jménem a barvou pozadí:
- `H: —` (šedý, nezapočato)
- `H: ⏳` (žlutý/accent, rozpracováno)
- `H: ✓` (zelený/primary, splněno)

Pro „Obě" se zobrazí dva chipy vedle sebe: `H: —` `K: ⏳`. Kliknutím na chip se cyklicky mění stav dané terapeutky. Výhoda: jasné kdo je kdo, jasný stav, žádné záhadné kolečko.

### Plán úprav

#### 1. `src/components/did/DidTherapistTaskBoard.tsx`

**Filtrování (řádky 609-643):**
- Přidat tlačítko "Vše" jako explicitní volbu (ne skrytý toggle)
- Při změně `assigneeFilter` synchronizovat i `newAssignee`
- Při změně `categoryFilter` synchronizovat i `newCategory`

**Semafor → badge (řádky 146-151, 192-201):**
- Nahradit komponentu `TrafficLight` novou `StatusBadge`
- Pro `both`: vždy zobrazit DVA badge (`H` + `K`)
- Pro `hanka`/`kata`: jeden badge
- Kliknutím cyklovat stav příslušné terapeutky

**Expanded detail (řádky 219-280):**
- Zobrazit celý text úkolu (ne truncated) — `task` + `note` sloučit do jednoho čitelného bloku

#### 2. `src/lib/parseOverviewTasks.ts`

**Funkce `truncateTitle` (řádky 76-90):**
- Zvýšit limit z 80 na 150 znaků
- Ořezávat POUZE na konci celé věty (tečka, dvojtečka), ne uprostřed slova
- Pokud se nenajde vhodný bod řezu, nechat celý text jako `task`

### Soubory k úpravě
1. `src/components/did/DidTherapistTaskBoard.tsx` — filtry, badge, zobrazení textu
2. `src/lib/parseOverviewTasks.ts` — truncation limit

