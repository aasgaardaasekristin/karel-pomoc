

# Audit: 10 posledních požadavků vs. realita

## Co jste požadoval (shrnutí z posledních ~10 vstupů)

| # | Požadavek | Kolikrát opakován | Splněno? | Proč ne |
|---|---|---|---|---|
| 1 | Karlův přehled musí začínat živým, souvislým odstavcem — ne jednou větou, ne seznamem jmen | **minimálně 8×** | ❌ NE | `buildNarrativeParagraphs()` jen přeformátuje surová DB data. Když `plan05ANarrative` je prázdný a interview fieldy jsou NULL, výstup je 1 věta z `recentThreads` |
| 2 | Karel musí vždy uvést: co ví, co z toho plyne, co navrhuje, co chce od Haničky, co chce od Káti | **minimálně 6×** | ❌ NE | Tato logika v kódu **vůbec neexistuje**. Builder nemá žádný blok „co navrhuji" ani „co chci od H/K" v narativu — ty sekce jsou jen v task listech níže, ale ne v úvodním textu |
| 3 | Porada otevřená z úkolu musí mít Karlův briefing (důvod, návrh, otázky pro H a K) | **minimálně 5×** | ❌ NE | `detail_instruction` je plain string, `buildMeetingSeed()` ho čte jako objekt → `reason/proposal/questionsHanka/questionsKata` jsou všechny prázdné |
| 4 | Karel je vůdce týmu, navrhuje sám, nikdy nedeleguje svou práci na terapeutky | **minimálně 4×** | ⚠️ ČÁSTEČNĚ | Role guard filter existuje (ř. 83-91), ale v DB jsou stále zakázané tasky (např. „Připrav pro Hanku krizový scénář") |
| 5 | Inline odpovědi musí jít do `did_pending_questions`, ne do `did_threads` | **3×** | ✅ ANO | Toto bylo opraveno (ř. 328-355) |
| 6 | Sezení s potvrzovacím workflow (Souhlasím/Změnit) | **2×** | ✅ ANO | Implementováno (ř. 700-743) |
| 7 | Deep-link seed pro porady nesmí ztratit kontext | **3×** | ❌ NE | sessionStorage se maže v renderu DidContentRouter |
| 8 | Návrat z porady nesmí vést do slepé větve | **2×** | ❌ NE | Nedotaženo |
| 9 | Karel nikdy nesmí říkat „V posledních dnech jsem komunikoval s…" | **minimálně 5×** | ❌ NE | Přesně tato věta se generuje na ř. 508-510 |
| 10 | Historické události se nesmí vydávat za aktuální | **2×** | ⚠️ ČÁSTEČNĚ | Temporal guard v denním cyklu doplněn, ale UI stále nemá vlastní validaci |

## Kořenová příčina všech selhání

**`buildNarrativeParagraphs()` (ř. 454-525) je pouhý formátovač surových dat, ne generátor narativu.**

Když jsou data bohatá → výstup je přijatelný.
Když jsou data chudá (což je teď případ: `plan05ANarrative` = prázdný, interview fieldy = NULL) → výstup je 1 věta.

**Kód nikdy neobsahoval logiku pro:**
- Karlův vlastní návrh na dnešek
- Syntézu „co z toho plyne"
- Adresné otázky pro Haničku a Káťu v rámci narativu
- Karlovo hodnocení situace

Tyto bloky byly v plánu popsány, ale **nikdy nebyly naimplementovány** — místo nich se pokaždé jen přeformátoval existující fallback.

## Co se musí změnit

### 1. `buildNarrativeParagraphs()` → kompletní přepis

Nový builder musí mít **povinné sekce**, které se vygenerují VŽDY, i když jsou DB data minimální:

```
VŽDY:
1. Oslovení ✅ (už funguje)
2. "Co vím" — shrnutí z dostupných dat (threads, interviews, tasks, crisis)
3. "Co z toho plyne" — odvozeno z kombinace krize + tasků + stáří dat
4. "Co navrhuji na dnes" — Karel sám navrhne na základě: sessions, pending tasks, crisis stavu
5. "Co potřebuji od Haničky" — odvozeno z hanka tasků + otázek
6. "Co potřebuji od Káti" — odvozeno z kata tasků + otázek
```

Každá sekce má deterministický fallback text, pokud pro ni nejsou specifická data. Například:
- "Co vím": pokud nejsou interviews ani plan05A, řekne co ví z threadů a tasků
- "Co navrhuji": pokud nejsou sessions, navrhne na základě nejurgetnějšího tasku
- "Co potřebuji od H/K": pokud nejsou specifické tasky, zeptá se obecně

**Klíčový princip: Builder NIKDY nevyprodukuje méně než 5 odstavců.**

### 2. Věta „X byl/a naposledy aktivní" → smazat

Řádky 508-510 se odstraní. Místo nich Karel shrne aktivitu v próze: „Dnes jsem řešil s Arthurem krizovou situaci. Káťa se připojila k úkolu ohledně…"

### 3. `buildMeetingSeed()` → parse string `detail_instruction`

`detail_instruction` je v DB string, ne JSON objekt. Seed musí:
- Použít celý string jako `reason`
- Doplnit `karelProposal` z kontextu tasku (task text + detail_instruction)
- Doplnit `questionsHanka`/`questionsKata` deterministicky podle `assigned_to`

### 4. Role guard → rozšířit regex

Aktuální `PROHIBITED_TASK_PATTERNS` nepokrývá „Připrav pro Hanku krizový scénář" (protože regex hledá `připrav` ale task začíná „Připrav" s velkým P a celý kontext je jiný). Rozšířím a zpřísním.

### 5. sessionStorage seed → opravit lifecycle

Seed se smaže až po úspěšném převzetí v `DidMeetingPanel`, ne v renderu `DidContentRouter`.

## Soubory k úpravě

| Soubor | Co |
|---|---|
| `src/components/did/KarelDailyPlan.tsx` | Kompletní přepis `buildNarrativeParagraphs()`, oprava `buildMeetingSeed()`, rozšíření role guard |
| `src/components/did/DidContentRouter.tsx` | sessionStorage lifecycle fix |
| `src/components/did/DidMeetingPanel.tsx` | Seed consumption + návrat |

Edge funkce (`karel-did-meeting`, `karel-did-daily-cycle`) se upraví až po ověření, že UI generuje správný seed — jinak se opět bude opravovat špatná vrstva.

## Pořadí

1. `KarelDailyPlan.tsx` — přepis builderu s povinnými sekcemi + oprava seedu + role guard
2. `DidContentRouter.tsx` — seed lifecycle
3. `DidMeetingPanel.tsx` — seed consumption + back navigation
4. Ověření výstupu
5. Teprve pak edge funkce

## Akceptační kritéria

- Karlův přehled má VŽDY minimálně 5 odstavců: co vím, co z toho plyne, co navrhuji, co chci od Haničky, co chci od Káti
- Věta „X byl/a naposledy aktivní" se NIKDY neobjeví
- Porada otevřená z úkolu nese plný `detail_instruction` jako důvod + automaticky doplněný návrh
- Zakázané tasky (delegující Karlovu práci) se nezobrazí
- sessionStorage seed přežije React re-render

