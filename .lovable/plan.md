

# Oprava izolace vzhledu na každé obrazovce

## Problém
V `Chat.tsx` (řádek 539-546) je useEffect, který při jakémkoli režimu kromě "report" nastaví `setContextKey("global")`. Tento efekt běží na úrovni rodiče a **přepisuje** context_key, který si nastavují dětské komponenty (`DidContentRouter`, `HanaChat`). Výsledek: DID a Hana režimy mají vždy "global" téma namísto svého vlastního.

Navíc chybí unikátní context_key pro Research režim, Zklidnění, Pomoc, Kartotéku (bez klienta) a další.

## Plán

### 1. Opravit useEffect v `Chat.tsx` (řádky 539-546)
Místo fallbacku na `"global"` nastavit context_key podle aktuálního režimu:

```
report → report_client_{id} / report_session_selector  (už funguje)
did    → NEMĚNIT (nechá DidContentRouter řídit vlastní key)
hana   → NEMĚNIT (nechá HanaChat řídit vlastní key)  
research → research / research_thread_{id}
default → "global"
```

Konkrétně: z useEffectu **odstranit** nastavování "global" pro `mainMode === "did"` a pro `mainMode === "hana"`, protože tyto režimy mají vlastní logiku v child komponentách. Pro `research` přidat vlastní key.

### 2. Přidat context_key pro Research režim v `Chat.tsx`
V useEffectu přidat:
- `mainMode === "research"` a `activeResearchThread` → `research_thread_{id}`
- `mainMode === "research"` bez vlákna → `"research"`

### 3. Přidat context_key pro Kartotéku bez klienta
V `Kartoteka.tsx` fallback bez vybraného klienta: `"kartoteka"` místo `"global"`.

### 4. Přidat context_key pro utility stránky
- `Pomoc.tsx` → `"pomoc"`
- `Zklidneni.tsx` / `CalmMode.tsx` → `"zklidneni"`
- `Hub.tsx` → `"hub"` místo `"global"`
- `Login.tsx` → `"login"`

### 5. Opravit DidContentRouter fallback
Řádky 168-171: bez activeThread v režimu "cast" by měl být key `"did_kids"` (ne `"did_katerina"`), a entry screen `"did_entry"`.

### 6. ThemeContext fallback
V `loadPrefsForContext`: pokud kontext nemá vlastní uložený vzhled, použije se **výchozí default** (uživatel to tak chce), ne globální.

## Soubory k úpravě
1. `src/pages/Chat.tsx` – useEffect s context_key + research keys
2. `src/components/did/DidContentRouter.tsx` – granularnější keys
3. `src/pages/Kartoteka.tsx` – fallback key
4. `src/pages/Hub.tsx` – "hub" key
5. `src/pages/Pomoc.tsx` – "pomoc" key  
6. `src/pages/Zklidneni.tsx` – "zklidneni" key
7. `src/pages/CalmMode.tsx` – "zklidneni" key
8. `src/pages/Login.tsx` – "login" key
9. `src/contexts/ThemeContext.tsx` – fallback na DEFAULT_PREFS místo globálních

