

# Opravy Live DID Session — 3 bugy

## 1. Image analysis BROKEN — špatný payload
**Problém**: `handleImageAnalysis` (řádky 222-234) posílá `{ fileBase64, fileName, mode }`, ale `karel-analyze-file` očekává `{ attachments: [...], mode, chatContext, userPrompt }`.

**Oprava**: Přepsat payload na správný formát — všechny `pendingImages` jako pole `attachments`:
```
attachments: pendingImages.map(img => ({
  dataUrl: img.dataUrl,
  name: img.name,
  category: "image",
  type: "image/jpeg",
  size: 0
})),
mode: "childcare",
chatContext: ...,
userPrompt: "DID část: ... Analyzuj obrázek..."
```

## 2. Analyzuje jen první obrázek
**Problém**: `pendingImages[0]` → jen první, zbytek se zahodí.

**Oprava**: Poslat celé pole. V user message zobrazit počet obrázků. Po analýze `clearImages()` → tlačítko Fotka zůstane → lze nahrát další obrázky kdykoliv během sezení.

## 3. Audio — chybí zobrazení maxima
**Problém**: Zobrazuje jen `1:23`, ale ne `/ 5:00`.

**Oprava**: Na řádku 470 změnit text na `{formatDuration(recorder.duration)} / {formatDuration(recorder.maxDuration)}`. Stejně tak u paused stavu (řádek 482).

## Soubor
- `src/components/did/DidLiveSessionPanel.tsx` — jediný soubor, 3 změny

