

## Oprava: Izolace thread vzhledu v režimu Kluci

**Zadání:** Fotka na pozadí z persony `kluci` prosakuje do thread-listu a DID rozcestníku, protože `setCurrentPersona("kluci")` mění globální stav celé aplikace. Fotka se má zobrazit JEN uvnitř konkrétního vlákna.

**Příčina:** `setCurrentPersona("kluci")` v `handleDidSubModeSelect` a `onSelectKluci` přepne globální theme na `kluci` (včetně fotky) ještě PŘED otevřením vlákna → fotka je vidět na thread-listu.

---

### Změna 1: ThemeContext — přidat `getPersonaPrefs` (read-only helper)

**Soubor:** `src/contexts/ThemeContext.tsx`

- Přidat novou funkci `getPersonaPrefs(persona: string): Promise<ThemePrefs>` — načte prefs z DB bez změny globálního stavu.
- S interní cache, aby se nequery DB při každém otevření vlákna.
- Přidat do `ThemeContextValue` interface a Provider value.

### Změna 2: Chat.tsx — odstranit globální přepnutí persony, izolovat theme na vlákno

**Soubor:** `src/pages/Chat.tsx`

1. **Odstranit** všechna volání `setCurrentPersona("kluci")` (řádky ~883, ~1599, ~1883).
2. **Odstranit** `setCurrentPersona("default")` při odchodu z thread-listu (řádek ~551) — nebude potřeba, protože se persona nikdy nepřepíná.

3. **`handleSelectThread`** — před `applyTemporaryTheme` nejdřív načíst základ `kluci` přes `getPersonaPrefs("kluci")`, pak přes něj vrstvit `thread.themeConfig`:
   ```
   const kluciBase = await getPersonaPrefs("kluci");
   const threadOverrides = thread.themeConfig (filtrované neprázdné);
   applyTemporaryTheme({ ...kluciBase, ...threadOverrides });
   ```
   Tím se fotka z `kluci` zobrazí jako základ, ale jen dočasně pro vlákno.

4. **`handleQuickThread`** — stejná logika jako bod 3.

5. **`restoreGlobalTheme()`** při odchodu z vlákna zůstává beze změny — vrátí se na `default` prefs (bez fotky), což je správné chování pro thread-list.

### Co se NEMĚNÍ
- `DidKidsThemeEditor` — draft inicializace z `prefs` bude fungovat správně, protože při otevření editoru (uvnitř vlákna) budou `prefs` už obsahovat správný základ `kluci` + thread override.
- Globální persona zůstane vždy `default` během celého Kluci toku.

### Logická kontrola efektů
- **Thread-list:** persona = `default`, žádná fotka → ✅ správně
- **Arturovo vlákno:** dočasný theme = `kluci` základ (s fotkou) + Arturovy barvy → ✅ fotka vidět
- **Odchod z vlákna:** `restoreGlobalTheme()` vrátí `default` → ✅ fotka zmizí
- **DID rozcestník:** persona = `default` → ✅ bez prosaku
- **Vlákno s vlastní fotkou:** thread override přebije `kluci` fotku → ✅ správně
- **Vlákno bez vlastní fotky:** zdědí `kluci` fotku → ✅ správně

