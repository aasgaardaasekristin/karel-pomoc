

# Audit: "Osvěž paměť" v DID režimu

## Zjištění

### Režim HANA – funguje
V `src/components/hana/HanaChat.tsx` (řádek 776) existuje tlačítko **"Osvěž paměť"** v dialogu "Správa":
- Volá `handleRefreshMemory()` → `runContextPrime(false)` → `karel-hana-context-prime`
- Načte epizody, entity, Drive složky, novinky → AI syntéza → vrátí `contextBrief` jako cache
- Cache se uloží do state `contextPrimeCache` a přilepí do system promptu každého dalšího volání

### Režim DID – CHYBÍ tlačítko "Osvěž paměť"
V `src/components/did/DidSprava.tsx` (dialog "Správa DID režimu") **NEEXISTUJE** tlačítko "Osvěž paměť". Obsahuje pouze:
- Aktualizovat kartotéku
- Aktualizovat Centrum
- Vyčistit úkoly
- Audit zdraví kartotéky
- Přeformátovat karty
- Bootstrap DID paměti

### DID context-prime – existuje, ale jen automaticky
Hook `useDidContextPrime` (`src/hooks/useDidContextPrime.ts`) volá edge funkci `karel-did-context-prime`. Tato funkce:
- Načte Drive složky (KARTOTEKA_DID, 00_CENTRUM, PAMET_KAREL)
- Načte epizody, entity, vzorce, strategie z DB
- Parsuje alias mapu z Excel registru
- AI syntéza → vrátí `contextBrief`, `systemState`, `activePartsLast24h`

**Kdy se volá automaticky:**
1. Při vstupu do pod-režimu "terapeut" (`DidContentRouter.tsx:188` → `runPrime(undefined, "mamka")`)
2. Při vstupu do pod-režimu "kluci/cast" (`DidContentRouter.tsx:193` → `runPrime(undefined, "cast")`)
3. Při otevření existujícího vlákna s částí (`Chat.tsx:634` → `runPrime(safePartName, "cast")`)

**Kdy se NEDÁ spustit ručně:**
- V DID Správě (DidSprava.tsx) žádné tlačítko pro ruční osvěžení neexistuje
- Uživatel nemá možnost vynutit refresh cache bez přepnutí pod-režimu

### Co dnes zastupuje "dynamicky situační cache"
1. **Automatický `runPrime`** při přepnutí → ale jen jednou, ne na vyžádání
2. **`karel-daily-refresh`** → plní `did_daily_context.context_json` (denní profil: počty částí, úkoly, vlákna)
3. **`karel-did-daily-analyzer`** → plní `did_daily_context.analysis_json` (AI analýza terapeutek, částí, rizik)
4. **`karel-chat/index.ts`** → čte `did_daily_context` a lepí "KARLŮV DENNÍ PROFIL" do system promptu

**Problém:** Denní kontext se generuje jednou denně (cron/manuálně), ale `runPrime` generuje živou 3D cache. Tyto dva systémy nejsou propojené – `runPrime` nepoužívá `analysis_json` a `daily-refresh` nepoužívá Drive data z `context-prime`.

## Plán nápravy

### 1. Přidat tlačítko "Osvěž paměť" do DidSprava.tsx
- Nový prop `onRefreshMemory` + `isRefreshingMemory` v `DidSprava`
- Nový `ToolButton` s ikonou `Brain`, text "Osvěž paměť", desc "Vynutit novou situační cache z Drive a DB"
- V `DidDashboard.tsx` předat callback, který zavolá `didContextPrime.runPrime()`

### 2. Propojit DidDashboard s useDidContextPrime
- `DidDashboard` aktuálně NEDOSTÁVÁ `didContextPrime` – musí se předat z `Chat.tsx` přes `DidContentRouter` → `DidDashboard`
- Přidat prop `onRefreshMemory` a `isRefreshingMemory` do `DidDashboard` → `DidSprava`

### 3. Volitelně: enrichovat runPrime o analysis_json
- V `karel-did-context-prime` přidat čtení posledního `analysis_json` z `did_daily_context`
- Přilepit shrnutí z analýzy do `contextBrief`, aby cache obsahovala i denní profil terapeutek a rizika částí

## Dotčené soubory
- `src/components/did/DidSprava.tsx` – přidat tlačítko
- `src/components/did/DidDashboard.tsx` – předat callback
- `src/components/did/DidContentRouter.tsx` – propojit props
- Volitelně: `supabase/functions/karel-did-context-prime/index.ts` – enrichment o analysis_json

