

# Rozbalitelné analýzy + Zpracovat záznam z médií

## Změny

### 1. SessionMediaUpload.tsx — rozbalitelné analýzy + auto-context

- Přidat `expandedItems: Set<string>` state
- U každé dokončené analýzy: tlačítko "Zobrazit celou analýzu" / "Skrýt" — toggle mezi 500 znaků a plný text, odstranit `max-h-32`
- Po dokončení každé analýzy automaticky volat `onMediaContext` s agregací všech hotových analýz (ne jen po kliknutí "Přidat do záznamu")
- Odstranit tlačítko "Přidat do záznamu" — kontext se aktualizuje automaticky

### 2. SessionIntakePanel.tsx — tlačítko "Zpracovat záznam z médií"

V `inputMode === "choose"` bloku, pod gridy tlačítek, pokud `mediaContext` existuje:
- Zobrazit tlačítko "📋 Zpracovat záznam z médií"
- Po kliknutí: zavolat `handleSubmit` upravenou pro media-only mode

Úprava `handleSubmit`:
- Nová podmínka: pokud `inputMode === "choose"` a `mediaContext` existuje → media-only mode
- `body.inputType = "text"`
- `body.textInput = "Sestav kompletní BIRP+S zápis sezení výhradně na základě přiložených analýz médií. Nevymýšlej žádné detaily které nejsou v analýzách. Pokud něco chybí, uveď to v dotazníku."`
- `body.mediaContext = mediaContext`

## Soubory

1. `src/components/report/SessionMediaUpload.tsx` — expandable + auto-context
2. `src/components/report/SessionIntakePanel.tsx` — media-only submit button + logic

## Co se NEZMĚNÍ
- Edge funkce (již zpracovává mediaContext)
- Logika ukládání (saveToDb)
- Stávající text/audio flow

