

# Jednotný vizuální styl AI výstupů — RichMarkdown

## Co se změní

Vytvoří se sdílená komponenta `src/components/ui/RichMarkdown.tsx` zapouzdřující `ReactMarkdown` s jednotným stylem. Pak se nahradí všechny přímé `<ReactMarkdown>` volání touto komponentou napříč celou aplikací.

## 1. Nová komponenta: `src/components/ui/RichMarkdown.tsx`

Zapouzdří `ReactMarkdown` s custom `components` prop:
- **h1, h2, h3**: `font-semibold text-foreground border-l-2 border-primary pl-3 py-1 mb-2 bg-muted/20 rounded-r`
- **p**: `text-sm leading-relaxed mb-2`
- **strong**: `font-semibold text-foreground`
- **em**: `italic text-muted-foreground`
- **ul**: `list-disc list-inside space-y-1 text-sm mb-2`
- **ol**: `list-decimal list-inside space-y-1 text-sm mb-2`
- **li**: `leading-relaxed`
- **blockquote**: `border-l-2 border-muted pl-3 italic text-muted-foreground`
- **a**: `text-primary underline` s `target="_blank"`

Props: `children: string`, `className?: string` (wrapper), `compact?: boolean` (menší velikost pro DID panely s `text-[11px]`)

## 2. Soubory k úpravě (nahradit `<ReactMarkdown>` za `<RichMarkdown>`)

### Hlavní chat výstupy
- **`src/components/ChatMessage.tsx`** — 3× `<ReactMarkdown>` v assistant zprávách
- **`src/components/calm/CalmChat.tsx`** — 1× assistant zprávy
- **`src/components/crisis/CrisisSupervisionChat.tsx`** — 2× chat + summary
- **`src/components/report/ClientDiscussionChat.tsx`** — 1× assistant zprávy

### Kartotéka / Report
- **`src/pages/Kartoteka.tsx`** — `SessionAnalysisView` fallbacky (3×)
- **`src/components/report/CardAnalysisPanel.tsx`** — 3× (profil, plan generating, plan review)
- **`src/components/report/SessionIntakePanel.tsx`** — 2× (summary, analysis tabs)
- **`src/components/report/PostSessionTools.tsx`** — 1× session report
- **`src/components/report/SessionMediaUpload.tsx`** — 1× audio analysis
- **`src/components/ReportOutput.tsx`** — 1× generated report
- **`src/components/StudyMaterialPanel.tsx`** — 1× study material

### DID režim
- **`src/components/did/DidDailySessionPlan.tsx`** — nahradit `renderMarkdown` + `dangerouslySetInnerHTML` za `<RichMarkdown compact>` (2×)
- **`src/components/did/DidSessionPrep.tsx`** — 1× briefing
- **`src/components/did/DidPersonalizedSessionPrep.tsx`** — 2× plan
- **`src/components/did/DidMeetingPanel.tsx`** — 2× meeting content + outcome
- **`src/components/did/DidSupervisionReport.tsx`** — 1× report
- **`src/components/did/DidMonthlyPanel.tsx`** — 1× monthly report
- **`src/components/did/DidAgreementsPanel.tsx`** — 1× weekly summary
- **`src/components/did/DidPartCard.tsx`** — 7× part summary sections

### Crisis
- **`src/components/crisis/CrisisImprintSection.tsx`** — 1× risk overview

## 3. SessionAnalysisView — update confidence badge styles

V `Kartoteka.tsx` aktualizovat confidence badge na nový standard:
- high: `bg-green-100 text-green-800 border border-green-200`
- medium: `bg-orange-100 text-orange-800 border border-orange-200`
- low: `bg-gray-100 text-gray-600 border border-gray-200`

Sekce (Analýza, Hypotéza, Doporučení) dostanou: `rounded-lg border bg-card p-3 mb-3` s nadpisem `text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2`.

Doporučení: každé jako karta `border rounded-lg p-2 mb-2`, název tučně, důvod muted kurzívou.

## 4. Odstraní se `renderMarkdown` helper

V `DidDailySessionPlan.tsx` se smaže funkce `renderMarkdown` a `dangerouslySetInnerHTML` se nahradí React komponentou `<RichMarkdown compact>`.

## Soubory dotčené celkem: ~20 souborů + 1 nový

## Technické detaily

- `RichMarkdown` bude pure wrapper bez side effects
- Přijímá `compact` prop pro DID panely (text-[11px] leading-relaxed místo text-sm)
- Všechny `prose prose-sm` wrapper divy zůstanou na volajícím, `RichMarkdown` renderuje jen obsah s custom components
- Import: `import RichMarkdown from "@/components/ui/RichMarkdown"`

