

# Oprava "Failed to fetch" u sestavení plánu procesu

## Analýza problému
Edge funkce `karel-therapy-process-plan` padá s "Failed to fetch" — pravděpodobně timeout. Funkce provádí:
1. 3 DB dotazy (klient, sezení, úkoly)
2. Perplexity research (až 25s timeout)
3. Gemini 2.5 Pro streaming s velkým systémovým promptem

Celkový čas snadno překročí default timeout edge funkce. Navíc klient nemá retry logiku ani timeout handling.

## Změny

### 1. Edge funkce `karel-therapy-process-plan/index.ts`
- Zkrátit Perplexity timeout z 25s na 15s
- Přidat retry (2 pokusy) pro AI gateway volání s 2s prodlevou
- Zkrátit `sessionsContext` limit (10 sezení × 400 znaků max)
- Přidat `DŮLEŽITÉ: Terapeutka se jmenuje HANIČKA` do system promptu (konsistence s card-analysis)

### 2. Klient `CardAnalysisPanel.tsx`
- Přidat `AbortController` s 120s timeout na fetch volání
- Přidat retry logiku (1 automatický retry při "Failed to fetch")
- Lepší error zpráva: "Sestavování plánu trvá příliš dlouho, zkuste to znovu"

## Soubory
- **Editovaný**: `supabase/functions/karel-therapy-process-plan/index.ts`
- **Editovaný**: `src/components/report/CardAnalysisPanel.tsx`

