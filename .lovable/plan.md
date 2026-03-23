

# Oprava zobrazení analýzy karty — odstranění raw JSON z UI

## Přehled

Problém: v Kartotéce záložka „Analýzy karty" zobrazuje surový JSON místo formátovaného textu. Hlavní příčina je na řádku 771 v `Kartoteka.tsx`: `{parsed?.clientProfile || a.content}` — fallback `a.content` je celý JSON blob.

## Kroky implementace

### 1. Nový soubor: `src/lib/parseCardAnalysis.ts`

Robustní parser specificky pro card analysis data:
- Vstup: raw string (`a.content` z DB)
- Pokusí se `JSON.parse` (s odstraněním markdown fences, double-encoded handling)
- Pokud se JSON extrahuje, vrátí typovaný objekt `{ clientProfile, diagnosticHypothesis, therapeuticProgress, nextSessionRecommendations, dataGaps }`
- Pokud parse selže, vrátí objekt s `clientProfile: "Analýza není k dispozici"` a prázdnými poli
- Nikdy nevrací raw JSON string

### 2. Zpevnění parseru v `supabase/functions/karel-card-analysis/index.ts`

Řádky 169-175 — vylepšit extrakci JSON z AI odpovědi:
- Regex pro nalezení JSON objektu `{...}` i když je obalený textem
- Pokud `JSON.parse` selže na celém stringu, zkusit najít první `{` a poslední `}` a parsovat substring
- Fallback: `clientProfile` = vyčištěný text bez JSON artefaktů

### 3. Oprava `src/pages/Kartoteka.tsx`

Řádky 715-737 a **kritický řádek 771**:
- Nahradit manuální `JSON.parse` + regex hack za volání `parseCardAnalysis(a.content)`
- **Řádek 771**: `{parsed?.clientProfile || a.content}` → `{parsed.clientProfile}` (parser vždy vrací neprázdný string)
- Všechny `parsed?.` přístupy zůstanou bezpečné, protože parser vrací kompletní objekt s defaults

### 4. Oprava `src/components/report/CardAnalysisPanel.tsx`

- Nahradit `sanitizeAnalysisResult` za použití `parseCardAnalysis` pro čištění dat
- V `handleSaveToCard` uložit už vyčištěná data

## Technické detaily

**`parseCardAnalysis` interface:**
```typescript
interface CardAnalysisResult {
  clientProfile: string;
  diagnosticHypothesis: { primary: string; differential: string[]; confidence: string; supportingEvidence: string[]; sources: string[] };
  therapeuticProgress: { whatWorks: string[]; whatDoesntWork: string[]; clientDynamics: string };
  nextSessionRecommendations: { focus: string[]; suggestedTechniques: string[]; diagnosticTests: string[]; thingsToAsk: string[] };
  dataGaps: string[];
}

export function parseCardAnalysis(raw: string): CardAnalysisResult
```

**Diff řádku 771 (Kartoteka.tsx) — co se změní:**
```text
// PŘED:
<RichMarkdown>{parsed?.clientProfile || a.content}</RichMarkdown>

// PO:
<RichMarkdown>{parsed.clientProfile}</RichMarkdown>
```

**Soubory dotčené:**
- Nový: `src/lib/parseCardAnalysis.ts`
- Editace: `supabase/functions/karel-card-analysis/index.ts` (parser řádky 169-175)
- Editace: `src/pages/Kartoteka.tsx` (řádky 715-771+)
- Editace: `src/components/report/CardAnalysisPanel.tsx` (sanitize logic)

