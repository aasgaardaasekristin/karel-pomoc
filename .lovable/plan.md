

# Část 1: Implementace — Anti-halucinační guardy + Uložení konzultací + Image upload

Plán byl schválen. Všechna ověření prošla. Zde je přesný implementační plán.

## 7 souborů ke změně

### A1. `supabase/functions/karel-supervision-discuss/index.ts`
**Ř. 38–51**: Po `const sessions = ...` vložit guard:
```typescript
const isCardEmpty = !client?.diagnosis && !client?.key_history && !client?.family_context && !client?.notes;
if (sessions.length === 0 && isCardEmpty && mode !== "chat") {
  return new Response(JSON.stringify({
    response: `Hani, klient **${clientName}** má v kartotéce zatím prázdnou kartu a žádná sezení.\n\nNemám z čeho analyzovat...`
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
```
`fullHistory` fallback: `|| "(žádná sezení)"`

**Ř. 73**: Do system promptu přidat KRITICKÉ PRAVIDLO (5 řádků anti-halucinační instrukce).

### A2. `supabase/functions/karel-client-research/index.ts`
**Ř. 38–41**: Stejný guard → "Bez diagnózy a historie nemám co zkoumat..."

### A3. `supabase/functions/karel-supervision-training/index.ts`
**Ř. 37–48**: Stejný guard → "Nemám dost informací pro simulaci klienta..."
`sessionHistory` fallback: `|| "(žádná sezení)"`

### A4. `supabase/functions/karel-client-session-prep/index.ts`
**Ř. 40–43**: Soft guard — `emptyCardWarning` string přidaný do system promptu.
**Ř. 165–166**: Přidat KRITICKÉ PRAVIDLO + `${emptyCardWarning}`.

### A5. `supabase/functions/karel-session-finalize/index.ts`
**Ř. 40**: Do promptu přidat: "Vycházej VÝHRADNĚ z přepisu live sezení. NEVYMÝŠLEJ si nic, co v přepisu není."
**Ř. 87**: System message rozšířit o anti-halucinační instrukci.

### B1. `src/components/report/ClientDiscussionChat.tsx`
- Import `supabase`, `Save` icon
- Přidat stav `saved` (boolean)
- Do headeru (ř. 137–143) přidat tlačítko "Uložit konzultaci":
  - Viditelné: `messages.length > 0 && !isLoading`
  - onClick: insert do `client_sessions` s `notes: "Supervizní konzultace s Karlem"`, `ai_analysis: fullTranscript`
  - Po uložení: `setSaved(true)`, toast, tlačítko → "✓ Uloženo" (disabled)

### C1. `src/components/report/LiveSessionPanel.tsx`
- Import `useImageUpload`, `ImageUploadButton`, `ImagePlus`, `Select`
- Přidat stavy: `imageAnalysisType` ("Kresba klienta" | "Rukopis klienta" | "Foto výrazu"), `isImageAnalyzing`
- Do audio recorder strip (ř. 253–300) přidat za audio sekci:
  - Select pro typ analýzy
  - Image upload tlačítko
- Handler `handleImageAnalysis`:
  - `chatContext` z `messages.map(m => \`${m.role}: ${m.content}\`).join("\n")` — messages mají `{role, content}` interface ✅
  - Volání `karel-analyze-file` s `{ attachments: [{name, type, data}], mode: "supervision", chatContext, userPrompt: "Toto je ${imageAnalysisType} KLIENTA (ne terapeuta). Analyzuj v kontextu live sezení." }`
  - Výsledek jako assistant zpráva v chatu

## Technické detaily

- `mode` je extrahována na ř. 26 ve všech edge funkcích ✅
- `ai_analysis` sloupec existuje v `client_sessions` ✅
- `karel-analyze-file` přijímá `{ attachments, mode, chatContext, userPrompt }` ✅
- Messages v LiveSessionPanel mají `{role: string, content: string}` interface ✅

Celkem ~114 řádků, 7 souborů, žádné DB migrace.

