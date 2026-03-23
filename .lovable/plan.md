

# Implementace: Vzhled tlačítko všude + připravená pozadí

## Nové soubory

### 1. `src/components/ThemeEditorDialog.tsx`
Extrakce theme editoru z `DidSprava.tsx` řádky 239-449 do samostatné Dialog komponenty. Přidání sekce **Připravená pozadí** (8 Unsplash obrázků) před "Nahrát vlastní":
- Žádné (reset), Les, Jezero, Hory, Louka, Mlha, Západ slunce, Textura
- Grid 2×4, thumbnaily 80×60px, klik = okamžitá aplikace do draftu
- Zachová draft pattern, ColorPicker helper, celou existující logiku

### 2. `src/components/ThemeQuickButton.tsx`
Reusable tlačítko `<Palette />` s `min-w-[44px] min-h-[44px]` touch target. Otevírá `ThemeEditorDialog`. Props: `className?`.

## Úpravy existujících souborů

### 3. `src/components/did/DidSprava.tsx`
- Záložka "theme" (ř. 239-449): nahradit za `<ThemeEditorDialog />` embed (inline bez vlastního Dialog wrapperu)
- Zachovat ToolButton, ColorPicker jako lokální helpery (ColorPicker se přesune do ThemeEditorDialog)

### 4. `src/components/hana/HanaChat.tsx` (ř. ~717)
- Přidat `<ThemeQuickButton />` vedle Správa popover v toolbaru

### 5. `src/pages/Kartoteka.tsx` (ř. ~555)
- Přidat `<ThemeQuickButton />` vedle TabsList

### 6. `src/components/report/LiveSessionPanel.tsx`
- Přidat `<ThemeQuickButton />` do action toolbaru

### 7. `src/components/did/DidContentRouter.tsx` (ř. ~505)
- Přidat `<ThemeQuickButton />` vedle existujícího "Můj vzhled" (pro dospělé terapeut vlákna)

## Unsplash pozadí (bez API klíče)
```
https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80  (les)
https://images.unsplash.com/photo-1439853949127-fa647821eba0?w=1920&q=80  (jezero)
https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80  (hory)
https://images.unsplash.com/photo-1500534314263-0869cef6150a?w=1920&q=80  (louka)
https://images.unsplash.com/photo-1485236715568-ddc5ee6ca227?w=1920&q=80  (mlha)
https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=1920&q=80  (západ)
https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1920&q=80  (textura)
```
Thumbnaily: `?w=200&q=60` verze stejných URL.

## Soubory (7)
1. **Nový**: `src/components/ThemeEditorDialog.tsx`
2. **Nový**: `src/components/ThemeQuickButton.tsx`
3. **Upravit**: `src/components/did/DidSprava.tsx`
4. **Upravit**: `src/components/hana/HanaChat.tsx`
5. **Upravit**: `src/pages/Kartoteka.tsx`
6. **Upravit**: `src/components/report/LiveSessionPanel.tsx`
7. **Upravit**: `src/components/did/DidContentRouter.tsx`

