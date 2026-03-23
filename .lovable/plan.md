

# Oprava pomalosti chatu – DID & Hana

## A) `karel-hana-chat/index.ts` – paralelizace analyzeInput

**Problém:** `analyzeInput()` (řádek 535) blokuje 1-3s před streamem. Přitom výsledek analýzy slouží hlavně pro: 1) filtrování epizod/strategií do situation cache, 2) background episode save.

**Řešení:** Spustit analýzu PARALELNĚ s DB queries (Promise.all), ne sekvenčně po nich. Analýza a DB load jsou nezávislé.

```typescript
// PŘED (sekvenční):
const [episodes, ...] = await Promise.all([...DB queries...]);
const analysis = await analyzeInput(messages, episodes, key); // BLOKUJE

// PO (paralelní):
const [dbResults, analysis] = await Promise.all([
  Promise.all([loadEpisodes, loadStrategies, ...]),
  analyzeInput(messages, [], key),  // episodes nepotřebuje pro klasifikaci
]);
```

Navíc přidat **AbortController s 8s timeout** na analyzeInput fetch + fallback na `getDefaultAnalysis()` při timeout.

**Soubor:** `supabase/functions/karel-hana-chat/index.ts` řádky 526-536

## B) `Chat.tsx` – zkrátit didInitialContext

**Problém:** `didInitialContext` limit je 80000 chars (řádek 1207), což je ~90k tokenů.

**Řešení:** Změnit limit z 80000 na 8000 chars. Zkrátit `didContextPrimeCache` na max 2000 chars.

**Soubor:** `src/pages/Chat.tsx` řádky 1207-1217

```typescript
// Změnit 80000 → 8000
const trimmedContext = didInitialContext && didInitialContext.length > 8000
  ? didInitialContext.slice(-8000)  // zachovat KONEC (novější data)
  : didInitialContext;

// Přidat trim pro primeCache
const trimmedPrimeCache = didContextPrime.primeCache && didContextPrime.primeCache.length > 2000
  ? didContextPrime.primeCache.slice(-2000)
  : didContextPrime.primeCache;
```

## C) `Chat.tsx` – zprávy 30 → 20

**Řešení:** Řádek 1206: `messages.slice(-30)` → `messages.slice(-20)`

**Soubor:** `src/pages/Chat.tsx` řádek 1206

## D) `karel-hana-chat` – timeout na fetch volání

Přidat AbortController s 10s timeout na:
1. `analyzeInput()` – fetch na řádku ~150 (AI gateway call)
2. `saveEpisodeInBackground()` – fetch na řádku ~450 (AI gateway call)

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10000);
try {
  const response = await fetch(url, { ...opts, signal: controller.signal });
  clearTimeout(timeout);
} catch (e) {
  clearTimeout(timeout);
  if (e.name === 'AbortError') return getDefaultAnalysis(msg);
  throw e;
}
```

**Soubor:** `supabase/functions/karel-hana-chat/index.ts` funkce `analyzeInput` + `saveEpisodeInBackground`

## Soubory k úpravě
1. `supabase/functions/karel-hana-chat/index.ts` – paralelizace + timeouty
2. `src/pages/Chat.tsx` – context trim + message limit

## Co se NEMĚNÍ
- DID mamka/kata flow
- Kvalita odpovědí (analýza stále běží, jen paralelně)
- Background saveEpisode logika (jen přidán timeout)

