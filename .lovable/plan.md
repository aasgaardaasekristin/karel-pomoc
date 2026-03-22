

# Fix: BIRP+S vizuální formátování

## Problém
AI vrací summary jako jednořádkový text "Strukturovaný zápis ve formátu BIRP+S: B – PREZENTACE KLIENTA: ..." — vizuálně nepřehledné.

## Řešení — 2 změny

### 1. `supabase/functions/karel-session-intake/index.ts` (ř. 99-104)

Nahradit stávající instrukci za:
- Přidat explicitní větu: `Pole "summary" MUSÍ obsahovat markdown text s nadpisy ## pro každou sekci BIRP+S. Každá sekce na novém řádku. NEPIŠ prefix "Strukturovaný zápis ve formátu BIRP+S:" — začni rovnou sekcí ## B.`
- Změnit JSON ukázku `summary` na:
```
"summary": "## B – PREZENTACE KLIENTA\n[chování, vzhled, nálada]\n\n## I – INTERVENCE\n[techniky]\n\n## R – ODPOVĚĎ KLIENTA\n[reakce, posun]\n\n## P – PLÁN\n[zaměření příště]\n\n## S – SUPERVIZNÍ POZNÁMKA (Karel)\n[hypotézy, rizika]"
```

### 2. `src/components/report/SessionIntakePanel.tsx` (ř. 20-21)

Přidat `formatBirps` helper funkci hned za `SPINNER_CHARS`:

```typescript
const formatBirps = (raw: string): string => {
  if (!raw || raw === "—") return raw;
  if (raw.includes("## B")) return raw; // already formatted
  let text = raw.replace(/^Strukturovaný zápis ve formátu BIRP\+S:\s*/i, "");
  return text
    .replace(/B\s*[–-]\s*PREZENTACE KLIENTA:?\s*/g, "## B – PREZENTACE KLIENTA\n")
    .replace(/I\s*[–-]\s*INTERVENCE:?\s*/g, "\n## I – INTERVENCE\n")
    .replace(/R\s*[–-]\s*ODPOVĚĎ KLIENTA:?\s*/g, "\n## R – ODPOVĚĎ KLIENTA\n")
    .replace(/P\s*[–-]\s*PLÁN:?\s*/g, "\n## P – PLÁN\n")
    .replace(/S\s*[–-]\s*SUPERVIZNÍ POZNÁMKA[^:]*:?\s*/g, "\n## S – SUPERVIZNÍ POZNÁMKA (Karel)\n");
};
```

Na ř. 237 změnit rendering:
```tsx
<ReactMarkdown>{formatBirps(result.sessionRecord?.summary || "—")}</ReactMarkdown>
```

## Výsledek
- Nové generace: AI vrací markdown s `##` nadpisy → ReactMarkdown renderuje sekce vizuálně
- Staré/fallback: `formatBirps()` regex rozseká jednořádkový text na sekce s nadpisy
- Žádná DB migrace, 2 soubory, ~15 řádků

