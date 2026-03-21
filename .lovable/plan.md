

# Vizuální vyčištění DidDailySessionPlan

## Problémy (ze screenshotů)

1. **Zbytečné badges** — "Naléhavost: 99", "therapist_override +99", "✓ Drive", "✓ Email" zabírají místo a jsou pro terapeutku irelevantní. Urgency breakdown badges (řádky 506-510) zobrazují interní klíče scoringu.

2. **Nejednotné písmo tlačítek** — "Probíhá" badge, "Otevřít live asistenci", "Ukončit sezení" mají různé velikosti (`text-[10px]`, `h-6`, `h-5`). Některá mají ikony, jiná ne.

3. **Rozbalený plán** — surový markdown s `##`, `###`, `*` a `---` se renderuje jako plain text (`whitespace-pre-line`), což vypadá neprofesionálně. Chybí skutečné formátování.

## Plán oprav

### 1. Odstranit technické badges (řádky 499-511, 572-577)
- **Ponechat**: jméno části (selected_part) jako hlavní badge
- **Skrýt**: Naléhavost score, urgency_breakdown items, "✓ Drive", "✓ Email"
- Naléhavost zachovat jen jako subtle indicator (malá tečka — zelená/oranžová/červená podle hodnoty)

### 2. Sjednotit tlačítka (řádky 514-578)
- Všechna tlačítka: `h-7 text-[11px]` jednotně
- Status badge + akční tlačítka na jednom řádku, konzistentní gap
- Odstranit duplikátní ikony u badges vs. tlačítek

### 3. Markdown rendering (řádky 580-586)
- Nahradit `whitespace-pre-line` skutečným markdown parserem
- Použít `dangerouslySetInnerHTML` s jednoduchým regex-based formátováním:
  - `## ` → `<h3>`, `### ` → `<h4>`
  - `* **text**` → tučný list item
  - `---` → `<hr>`
- Obalit do prose-like třídy s Tailwind typografií

### Soubor k úpravě
- `src/components/did/DidDailySessionPlan.tsx` — jediný soubor

### Žádné nové závislosti
Jednoduchý regex markdown parser inline, žádná knihovna.

