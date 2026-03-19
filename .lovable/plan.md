

# Oprava DID-Kluci: tvorba vláken + izolace vzhledu

## Shrnutí problémů

1. **Nové vlákno se nevytváří** — `handlePartSelected` volá `getThreadByPart` a vrací existující vlákno za 24h, místo aby vytvořilo nové.
2. **Vzhled prosakuje** — `DidKidsThemeEditor` na řádku 1910 v `Chat.tsx` je renderovaný na úrovni thread-list. Navíc `handleApplyTheme` volá `updatePrefs(draft)`, což zapisuje do globální `user_theme_preferences`.
3. **`applyPreset` v `handleSelectThread`** na ř. 628 zapisuje globálně do DB místo dočasné aplikace.
4. **Chybí `thread_label`** — nelze oddělit zadané jméno (Tundrupek) od canonical části (Arthur).

---

## Plán oprav

### 1. Migrace: přidat `thread_label` + `entered_name` do `did_threads`

```sql
ALTER TABLE did_threads 
  ADD COLUMN thread_label text DEFAULT '',
  ADD COLUMN entered_name text DEFAULT '';
```

### 2. `Chat.tsx` — opravit thread-list (ř. 1905-1926)

- **Odstranit** `<DidKidsThemeEditor />` ze screenu `thread-list` (ř. 1909-1911). Na úrovni seznamu vláken nechat pouze globální tlačítko "Upravit vzhled" bez `threadId` (globální pro personu kluci).
- V `handleSelectThread` (ř. 627-628): nahradit `applyThemePreset(thread.themePreset)` za `applyTemporaryTheme({ primary_color: ..., accent_color: ... })` z KIDS_PRESETS lookup — nikdy nevolat `applyPreset` pro thread-scoped theme.
- V `handleDidBackHierarchical` ověřit, že `restoreGlobalTheme()` se volá vždy při návratu z chatu do thread-list.

### 3. `Chat.tsx` — opravit `handlePartSelected` (ř. 653-726)

- **Odstranit deduplikaci**: smazat blok `getThreadByPart` + early return (ř. 664-686). Klik na "Nové vlákno" vždy vytvoří nové vlákno.
- Předat `thread_label` (zadané jméno) a `entered_name` do `createThread`.
- Po detekci canonical části (fuzzy match z `DidPartIdentifier`): `part_name = canonical`, `thread_label = zadanéJméno`, `entered_name = rawInput`.

### 4. `useDidThreads.ts` — rozšířit `createThread` a interface

- Přidat `threadLabel` a `enteredName` do `DidThread` interface.
- `createThread` přijme nový parametr `options?: { threadLabel?: string; enteredName?: string; forceNew?: boolean }`.
- Když `forceNew === true`, přeskočit deduplikační query a rovnou insertovat.
- Insert bude obsahovat `thread_label` a `entered_name`.
- `rowToThread` namapuje nová pole.

### 5. `DidKidsThemeEditor.tsx` — rozdělit thread vs. globální režim (ř. 86-117)

- Když `threadId` je set: **nevolat** `updatePrefs(draft)` (ř. 89). Místo toho pouze:
  - Dočasně aplikovat přes `applyTemporaryTheme(config)`.
  - Zavolat `onThreadThemeSaved(threadId, preset, config)`.
  - Zalogovat do `did_part_theme_preferences`.
- Když `threadId` **není** set: chování zůstane jako dnes (globální persona).
- Přidat předvolené obrázky na pozadí (vesmír, les, oceán) jako rychlou volbu vedle upload tlačítka.

### 6. `DidPartIdentifier.tsx` — zjednodušit

- Ponechat pouze textový vstup "Jak ti říkají?" (již hotovo z předchozí úpravy).
- Po odeslání: fuzzy match proti `knownParts`, pak volat `onSelectPart` s objektem `{ canonical: "Arthur", label: "Tundrupek", raw: "tundrupek" }` místo pouhého stringu.
- Alternativa (jednodušší): `onSelectPart` vrátí tuple/objekt `{ partName, threadLabel }`.

### 7. `DidThreadList.tsx` — zobrazit `threadLabel`

- V seznamu vláken zobrazit `thread.threadLabel || thread.partName` místo jen `thread.partName`.
- Emoji/avatar threadu zobrazit jako malý odznak, ne jako přebarvení celé obrazovky.

### 8. `ThemeContext.tsx` — drobná oprava

- `applyTemporaryTheme`: pokud je `savedPrefsRef.current` již naplněný (= už jsme v dočasném režimu), neukládat znovu — zachovat původní globální stav.

---

## Předvolené obrázky na pozadí

Do `DidKidsThemeEditor` přidat grid s předvolenými obrázky (vedle upload):
- Vesmír, Les, Oceán, Drak (4 veřejné URL z `theme-backgrounds` bucketu nebo externích free zdrojů)
- Klik nastaví `background_image_url` v draftu, uloží se per-thread do `theme_config`

---

## Soubory k úpravě

| Soubor | Změna |
|--------|-------|
| Migrace SQL | `thread_label`, `entered_name` na `did_threads` |
| `src/pages/Chat.tsx` | Odstranit editor z thread-list, opravit handlePartSelected, opravit handleSelectThread |
| `src/components/did/DidKidsThemeEditor.tsx` | Rozdělit thread/global režim, přidat předvolené obrázky |
| `src/hooks/useDidThreads.ts` | Rozšířit interface + createThread o label + forceNew |
| `src/components/did/DidPartIdentifier.tsx` | Vrátit `{ partName, threadLabel }` |
| `src/components/did/DidThreadList.tsx` | Zobrazit threadLabel |
| `src/contexts/ThemeContext.tsx` | Neopakovaně ukládat savedPrefs |

---

## Výsledek

- "Nové vlákno" vždy vytvoří nový záznam
- Tundrupek = nové vlákno s `part_name=Arthur`, `thread_label=Tundrupek`
- Vzhled z konkrétního vlákna nikdy neprosakuje do seznamu ani výš
- Každé vlákno si drží vlastní vzhled v `theme_config` po celou dobu existence
- Na úrovni thread-list zůstává globální kluci vzhled s možností globální úpravy
- Předvolené obrázky na pozadí (vesmír, les...) dostupné v editoru

