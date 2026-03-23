

# Přepis vzhledu na čistý localStorage

## Co se změní

Celý systém per-stránkového vzhledu přejde z DB (`user_theme_preferences` + `context_key`) na **localStorage**. ThemeContext zůstane jen jako „CSS aplikátor" — nebude řídit, KTERÝ vzhled se načte. Každá stránka si sama načte/uloží svůj vzhled.

## Architektura

```text
ThemeQuickButton(storageKey="theme_hub")
  ├─ otevření: načte localStorage["theme_hub"] || DEFAULT
  ├─ uložení: zapíše localStorage["theme_hub"]
  └─ ihned: volá applyTemporaryTheme(prefs)

Stránka mount:
  useEffect → localStorage.getItem(storageKey) → applyTemporaryTheme()
  
Stránka unmount:
  useEffect cleanup → restoreGlobalTheme()
```

## Soubory k úpravě

### 1. `src/components/ThemeQuickButton.tsx`
- Přidat prop `storageKey: string`
- Přidat prop `onPrefsLoaded?: (prefs: ThemePrefs) => void` (volitelné)
- Při otevření editoru: předat `storageKey` do `ThemeEditorDialog`

### 2. `src/components/ThemeEditorDialog.tsx`
- Přidat prop `storageKey?: string`
- Pokud `storageKey` je zadán:
  - `draft` se inicializuje z `localStorage[storageKey]` nebo DEFAULT_PREFS
  - "Použít změny" zapíše do `localStorage[storageKey]` + zavolá `applyTemporaryTheme(draft)`
  - **Neukládá do DB**
- Pokud `storageKey` chybí: chování jako dosud (fallback)

### 3. `src/contexts/ThemeContext.tsx`
- **Beze změny struktury** — pouze exportovat `DEFAULT_PREFS` aby ho mohly stránky importovat
- `applyTemporaryTheme` a `restoreGlobalTheme` zůstávají jak jsou

### 4. Každá stránka — přidat 2 useEffecty + předat storageKey

**`src/pages/Hub.tsx`** — `storageKey="theme_hub"`
**`src/pages/Login.tsx`** — `storageKey="theme_login"`
**`src/pages/CalmMode.tsx`** — `storageKey="theme_zklidneni"`
**`src/pages/Zklidneni.tsx`** — `storageKey="theme_zklidneni"`
**`src/pages/Pomoc.tsx`** — `storageKey="theme_pomoc"`
**`src/pages/Kartoteka.tsx`** — `storageKey="theme_kartoteka_{clientId}"` / `"theme_kartoteka"`
**`src/pages/NotFound.tsx`** — `storageKey="theme_global"`

**`src/pages/Chat.tsx`** — dynamický storageKey podle režimu:
- report + klient → `theme_report_{clientId}`
- report bez klienta → `theme_report`
- research + vlákno → `theme_research_{threadId}`
- research → `theme_research`
- DID a Hana → nechá child komponenty

**`src/components/did/DidContentRouter.tsx`**:
- mamka/kata → `theme_did_katerina`
- cast + vlákno → `theme_did_kids_{threadId}`
- cast bez vlákna → `theme_did_kids`
- entry → `theme_did_entry`

**`src/components/hana/HanaChat.tsx`**:
- s vláknem → `theme_hana_{conversationId}`
- bez vlákna → `theme_hana`

### 5. Vzorový useEffect pro každou stránku

```typescript
// Na stránce, např. Hub.tsx:
const storageKey = "theme_hub";
const { applyTemporaryTheme, restoreGlobalTheme } = useTheme();

useEffect(() => {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
  }
  return () => { restoreGlobalTheme(); };
}, [storageKey]);
```

### 6. Odstranit z Chat.tsx
- Celý useEffect na řádcích 539-553 (setContextKey podle mainMode) — **smazat**
- Odstranit volání `setContextKey` z Chat.tsx, DidContentRouter, HanaChat, Hub, Login, Pomoc, CalmMode, Zklidneni, Kartoteka
- setContextKey volání se nahradí localStorage logikou

## Co se NEZMĚNÍ
- `ThemeContext.tsx` — struktura, `applyTemporaryTheme`, `restoreGlobalTheme`, CSS aplikace
- Žádná DB migrace
- Žádné nové tabulky

## Shrnutí
9 souborů se upraví. Každá stránka bude mít 2 řádky useEffect (mount load + unmount restore) a předá `storageKey` do `ThemeQuickButton`. Editor bude ukládat/číst z localStorage místo DB.

