

# Formátovaný výstup AI analýzy sezení

## Co se změní

**`src/pages/Kartoteka.tsx`** — řádky 1024–1028

Nahradí se surový `<p>{s.ai_analysis}</p>` za komponentu `SessionAnalysisView`.

## Komponenta SessionAnalysisView

Definovaná přímo v `Kartoteka.tsx` (helper komponenta).

**Logika parsování:**
1. Zkusí `JSON.parse(text)`
2. Pokud selže a text začíná `{` nebo obsahuje ` ```json ` → odstraní code fences regexem `text.replace(/^```json\n?/, "").replace(/```$/, "").trim()` → zkusí parse znovu
3. Pokud parsing uspěje a má `summary` → strukturovaný výstup
4. Pokud nic nefunguje → `ReactMarkdown` fallback

**Strukturovaný výstup (z JSON):**
- `summary` → ReactMarkdown (BIRP+S sekce s `##` nadpisy)
- `diagnosticHypothesis` → badge s confidence %
- `therapeuticRecommendations` → odrážkový seznam
- `nextSessionFocus` → odrážkový seznam
- `questionnaire` → číslovaný seznam otázek
- `clientTasks` → odrážkový seznam úkolů

**Závislost:** Přidat `react-markdown` (už je v package.json? — ověřím při implementaci, pokud ne, přidám).

## Soubory
1. `src/pages/Kartoteka.tsx` — přidat `SessionAnalysisView`, nahradit řádky 1024–1028

