

# Opravy v LiveSessionPanel: upload, vizuální progress, tučné rady

## Co se změní

### 1. Dropdown "Kresba klienta" spustí upload (`LiveSessionPanel.tsx`)
- V `Select.onValueChange` přidat `setTimeout(() => fileInputRef.current?.click(), 100)` — po výběru typu se okamžitě otevře file picker
- Přejmenovat tlačítko "Foto" na "Nahrát" (funguje jako záložní trigger)

### 2. Vizuální progress bar při analýze obrázku i audia (`LiveSessionPanel.tsx`)
- Pod recorder strip přidat dva bloky (podmíněné `isAudioAnalyzing` / `isImageAnalyzing`):
  - `Loader2` spinner + text "Karel analyzuje audio nahrávku…" / "Karel analyzuje kresbu klienta…"
  - Indeterminate progress bar (`animate-indeterminate-progress` — již existuje v projektu)
- Odstranit starý jednoduchý `isAudioAnalyzing` text span

### 3. Tučné písmo pro rady Karla (`LiveSessionPanel.tsx` + `ChatMessage.tsx`)
- V `buildContext()` instrukce upravit: přidat explicitní pokyn **"Všechny přímé rady, co má terapeut říct klientovi, a tvé okamžité reakce/doporučení piš TUČNĚ pomocí \*\*bold\*\* markdown."**
- Tím Karel bude sám generovat `**tučný text**` pro akční rady
- ReactMarkdown v `ChatMessage.tsx` už bold renderuje správně — žádná změna tam není potřeba

## Soubory
- **Editovaný**: `src/components/report/LiveSessionPanel.tsx`
  - `Select.onValueChange` → trigger file picker
  - Přidání progress barů pro audio/image analýzu
  - Úprava system promptu v `buildContext()` pro bold rady

## Co se NEMĚNÍ
- `ChatMessage.tsx` (ReactMarkdown již podporuje bold)
- Audio recorder logika
- Edge funkce

