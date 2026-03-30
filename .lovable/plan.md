

## F15 — Systémová pravidla a oprava denního briefingu

### Přehled

Vytvoření sdíleného souboru `system-rules.ts` s tvrdými pravidly pro Karla, úprava denního dashboardu na dva separátní briefingy, a injekce pravidel do všech klíčových edge funkcí.

---

### Soubor 1: `supabase/functions/_shared/system-rules.ts` (NOVÝ)

Vytvoří se nový soubor obsahující:
- `SYSTEM_RULES` — kompletní konstanta s 7 pravidly (role v týmu, dva briefingy, oddělení terapie od koordinace, Locík = pes, aktivní vs neaktivní části, deduplikace, formát briefingu)
- `KNOWN_NON_PARTS` — pole řetězců (Locík variace)
- `isKnownNonPart(name)` — case-insensitive helper funkce

Přesný obsah dle zadání.

---

### Soubor 2: `supabase/functions/karel-daily-dashboard/index.ts`

**A) Import** — přidat `import { SYSTEM_RULES, isKnownNonPart } from "../_shared/system-rules.ts";`

**B) Deduplikační helper** — přidat `deduplicateTasks()` funkci před handler

**C) Filtrace aktivních částí** — v `fetchActiveParts24h` odfiltrovat entity kde `isKnownNonPart(t.part_name)` vrací true

**D) Filtrace úkolů** — v `fetchTasksData` odfiltrovat non-part entity

**E) Dva separátní briefingy** — hlavní změna v handleru (řádky ~448-500):
- Místo jednoho AI volání se provedou DVĚ volání:
  1. `SYSTEM_RULES + briefing pro Haničku prompt + briefingContext` → `hanaBriefing`
  2. `SYSTEM_RULES + briefing pro Káťu prompt + briefingContext` → `kataBriefing`
- Spojený výstup: `aiContent = "# BRIEFING PRO HANIČKU\n\n" + hanaBriefing + "\n\n---\n\n# BRIEFING PRO KÁŤU\n\n" + kataBriefing`
- `appData` se extrahuje z obou briefinků (JSON bloky)

**F) Uložení** — do Drive se uloží spojený markdown; `applyAppUpdates` zpracuje tasky z obou briefinků

---

### Soubor 3: `supabase/functions/karel-chat/index.ts`

**A) Import** — přidat `import { SYSTEM_RULES } from "../_shared/system-rules.ts";`

**B) Injekce** — na řádku 193 změnit:
```typescript
// Před:
systemPrompt = DID_MASTER_PROMPT + "\n\n" + systemPrompt;
// Po:
systemPrompt = SYSTEM_RULES + "\n\n" + DID_MASTER_PROMPT + "\n\n" + systemPrompt;
```

---

### Soubor 4: `supabase/functions/karel-crisis-daily-assessment/index.ts`

**A) Import** — přidat `import { SYSTEM_RULES } from "../_shared/system-rules.ts";`

**B) Injekce** — v callAI volání na řádku ~153 přidat SYSTEM_RULES na začátek systemPrompt:
```typescript
const fullSystemPrompt = SYSTEM_RULES + "\n\n" + systemPrompt;
const assessment = await callAI(fullSystemPrompt, userMessage, LOVABLE_API_KEY);
```

---

### Deployment

Po implementaci deploy tří edge funkcí:
1. `karel-chat`
2. `karel-daily-dashboard`
3. `karel-crisis-daily-assessment`

---

### Technické detaily

- `SYSTEM_RULES` se vždy předřazuje PŘED vše ostatní (je to "ústavní zákon" systému)
- Pořadí v karel-chat: `SYSTEM_RULES → DID_MASTER_PROMPT → contextual prompt`
- Deduplikace úkolů: klíč = `assigned_to|part_name|first30chars`
- Filtr neaktivních částí: dashboard prompt již obsahuje instrukci; fyzický filtr v `fetchActiveParts24h` odstraní non-part entity
- Žádná existující logika se nemaže — pouze přidání importů, pravidel a rozdělení AI volání

