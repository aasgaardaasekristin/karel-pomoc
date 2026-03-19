
✅ HOTOVO: Parsování aliasů ze sloupce B Drive registru

## Co bylo opraveno

### 1. Sdílená utilita `_shared/driveRegistry.ts`
- `parseAliases("ARTHUR (ARTUR, ARTÍK)")` → `{ primary: "ARTHUR", aliases: ["ARTUR", "ARTÍK"] }`
- `scoreEntryMatch()` — porovnává vstup proti primárnímu jménu I každému aliasu zvlášť
- `buildAliasMapText()` — generuje textovou mapu aliasů pro context injection
- `buildAliasLookup()` — normalizovaný alias → kanonické jméno

### 2. `karel-did-part-detect` (live detekce identity)
- Parsuje sloupec B na primární jméno + aliasy
- Matchuje vstup proti každému aliasu individuálně (ne proti slepenci)
- `"artik"` → match na alias `ARTÍK` → vrátí kanonické `ARTHUR`
- `"dymi"` → match na alias `DYMI` → vrátí kanonické `DMYTRI`
- Výstup obsahuje `matchedAlias` — který alias byl trefen

### 3. `karel-did-context-prime` (Osvěž paměť)
- Při refreshi načítá Drive registry a parsuje aliasy
- Injektuje mapu aliasů do situační cache:
  ```
  ARTHUR = ARTUR, ARTÍK
  DMYTRI = DYMI, DYMKO
  ```
- Karel po refreshi ví, že aliasy jsou totožné identity

### 4. `karel-did-system-overview` (Přehled)
- Načítá Drive registry aliasy a přidává je do `partAliasMap`
- Přehled seskupuje `ARTUR / ARTÍK / ARTHUR` pod jednu identitu
- Nepřímé zmínky aliasů se správně mapují na kanonickou část

## Výsledek
- `artík` → `ARTHUR` ✅
- `artur` → `ARTHUR` ✅
- `dymi` → `DMYTRI` ✅
- „Osvěž paměť" načte alias mapu z Drive ✅
- Overview nesekupuje identity do fragmentů ✅
