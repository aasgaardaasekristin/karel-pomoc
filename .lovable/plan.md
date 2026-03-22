

# Oprava crash limitu sezení + persistentní data v Kartotéce

## Problém 1: Crash aplikace (bílá obrazovka)
`ActiveSessionsContext.tsx` řádek 87: `throw new Error(...)` uvnitř `setSessions` callbacku způsobí unhandled exception → bílá obrazovka.

## Problém 2: Data se ztrácejí při přepínání záložek
Radix Tabs ve výchozím nastavení **odmontovává** neaktivní `TabsContent`. Všechna vygenerovaná data (analýza, plán procesu, příprava sezení, rozhovor) žijí v lokálním stavu komponent → přepnutí záložky = ztráta všeho.

## Změny

### 1. `ActiveSessionsContext.tsx` — soft handling
- Limit z 5 → 50
- Místo `throw new Error(...)` → `console.warn()` + `toast()` + `return prev`
- Vrátit ID existující session nebo prázdný string (bez crash)

### 2. `Kartoteka.tsx` — forceMount na záložky
- Přidat `forceMount` na všechny `TabsContent` komponenty
- Obalit je `div` s `className={activeTab === "X" ? "" : "hidden"}` — obsah zůstane v DOM ale skrytý
- Tím se zachová veškerý stav komponent (analýza, plán, chat, příprava) i při přepínání záložek

## Soubory
- **`src/contexts/ActiveSessionsContext.tsx`** — limit + soft error
- **`src/pages/Kartoteka.tsx`** — forceMount + hidden pattern

