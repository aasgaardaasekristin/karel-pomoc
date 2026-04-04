

# F17-A — Přidání SYSTEM_RULES do všech výstupních Edge funkcí

## Problém

SYSTEM_RULES (pravidla zakazující míchání terapeutických dat, zveřejňování obsahu v mailech atd.) jsou importovány pouze ve **3 ze 70+ funkcí**. Ostatní funkce generují výstupy bez těchto pravidel — proto Karel v mailech a briefingách porušuje pravidla.

## Rozsah změn

Žádná logika se nemaže ani nemění. Pouze se přidá import a prepend `SYSTEM_RULES` do system promptů AI volání.

### Vzor (z karel-chat):
```typescript
import { SYSTEM_RULES } from "../_shared/system-rules.ts";
// ...
systemPrompt = SYSTEM_RULES + "\n\n" + systemPrompt;
```

## FÁZE 1 — Kritické (výstup pro uživatele / mail)

| # | Funkce | AI volání | Aktuálně má SYSTEM_RULES? |
|---|--------|-----------|--------------------------|
| 1 | `karel-did-daily-cycle` | ~9 (briefing gen, analysis, feedback, claims, handbook, card updates...) | ❌ NE |
| 2 | `karel-did-daily-email` | 1 | ❌ NE |
| 3 | `karel-email-report` | 1 | ❌ NE |
| 4 | `karel-did-morning-brief` | 1 | ❌ NE |
| 5 | `karel-did-weekly-cycle` | 2 (analysis + email) | ❌ NE |
| 6 | `karel-did-monthly-cycle` | 1 | ❌ NE |
| 7 | `karel-hana-chat` | 3 (detect, context build, main response) | ❌ NE |

## FÁZE 2 — Analytické funkce

| # | Funkce | AI volání | Aktuálně má SYSTEM_RULES? |
|---|--------|-----------|--------------------------|
| 8 | `karel-thread-analyzer` | 1 | ❌ NE |
| 9 | `karel-internal-analysis` | 1 | ❌ NE |
| 10 | `karel-did-context-prime` | 3 (compress, bonds, main) | ❌ NE |
| 11 | `karel-hana-context-prime` | 2 (compress, main) | ❌ NE |
| 12 | `karel-did-episode-generate` | 3 (main, classify, cross-mode) | ❌ NE |
| 13 | `karel-did-meeting` | 2 (moderation, final) | ❌ NE |

## Postup pro každou funkci

1. Přidat `import { SYSTEM_RULES } from "../_shared/system-rules.ts";` na začátek souboru
2. U **každého** AI volání v té funkci: přidat `SYSTEM_RULES + "\n\n"` na začátek system prompt stringu
3. Neměnit nic jiného

## Souhrn

- **Celkem funkcí k úpravě:** 13
- **Celkem AI volání která dostanou SYSTEM_RULES:** ~21
- **Před:** 3 funkce měly SYSTEM_RULES (karel-chat, karel-daily-dashboard, karel-crisis-daily-assessment)
- **Po:** 16 funkcí bude mít SYSTEM_RULES
- **Žádná logika se nemaže, žádná struktura se nemění**

