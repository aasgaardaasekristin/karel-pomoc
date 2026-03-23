

# Oprava race condition: localStorage vs DB v ThemeContext

## Problém
`ThemeContext.tsx` řádek 301-303 — `useEffect` vždy volá `loadPrefsForContext()` při změně `currentContextKey`. Tato DB query vrátí data asynchronně a zavolá `setPrefs()`, čímž **přepíše** téma, které stránka právě aplikovala přes `applyTemporaryTheme()` z localStorage.

## Řešení — localMode flag

### 1. `src/contexts/ThemeContext.tsx`

**Přidat stav:**
```typescript
const [localMode, setLocalModeState] = useState<string | null>(null);
```

**Přidat do interface + provider:**
```typescript
setLocalMode: (key: string | null) => void;
```

**Upravit useEffect (řádek 301-303):**
- Pokud `localMode !== null` → přeskočit DB load
- Přidat cancellation flag pro async race

```typescript
useEffect(() => {
  if (localMode !== null) return; // stránka řídí téma sama
  let cancelled = false;
  (async () => {
    await loadPrefsForContext(currentContextKey);
    // loadPrefsForContext already calls setPrefs internally,
    // but we need the cancelled check inside it
  })();
  return () => { cancelled = true; };
}, [currentContextKey, loadPrefsForContext, localMode]);
```

**Upravit `loadPrefsForContext`** — přijmout optional `signal` nebo přidat cancelled ref aby async result nepřepsal stav po unmount.

**Upravit `applyTemporaryTheme`** (řádek 403-408) — opravit stale closure:
```typescript
const applyTemporaryTheme = useCallback((config: Partial<ThemePrefs>) => {
  setPrefs((prev) => {
    if (!savedPrefsRef.current) savedPrefsRef.current = prev;
    return { ...prev, ...config };
  });
}, []); // no deps needed — uses functional updater
```

### 2. Všechny stránky s `THEME_STORAGE_KEY` (6 souborů)

Přidat `setLocalMode` do destrukturingu `useTheme()` a zavolat v existujícím useEffectu:

```typescript
const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();

useEffect(() => {
  setLocalMode(THEME_STORAGE_KEY);
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved) {
    try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
  }
  return () => {
    setLocalMode(null);
    restoreGlobalTheme();
  };
}, []);
```

**Soubory:**
- `src/pages/Hub.tsx`
- `src/pages/Login.tsx`
- `src/pages/Pomoc.tsx`
- `src/pages/Zklidneni.tsx`
- `src/pages/CalmMode.tsx`
- `src/pages/NotFound.tsx`

### 3. DID + Hana komponenty

Zkontrolovat `DidContentRouter.tsx` a `HanaChat.tsx` — pokud mají vlastní localStorage useEffect, přidat `setLocalMode` stejným způsobem.

## Soubory k úpravě
1. `src/contexts/ThemeContext.tsx` — localMode state + guard v useEffect + fix applyTemporaryTheme closure
2. `src/pages/Hub.tsx` — setLocalMode
3. `src/pages/Login.tsx` — setLocalMode
4. `src/pages/Pomoc.tsx` — setLocalMode
5. `src/pages/Zklidneni.tsx` — setLocalMode
6. `src/pages/CalmMode.tsx` — setLocalMode
7. `src/pages/NotFound.tsx` — setLocalMode
8. `src/components/did/DidContentRouter.tsx` — setLocalMode (pokud má localStorage)
9. `src/components/hana/HanaChat.tsx` — setLocalMode (pokud má localStorage)

