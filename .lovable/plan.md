

## Plan: Enforce Activity vs. Mention Distinction Across All Karel Processes

### Problem

The "dormancy guard" (distinguishing direct part activity from therapist mentions) was applied only to cycle reports (daily/weekly/monthly). But Karel still generates incorrect outputs in:

1. **Session Prep** (`karel-did-session-prep`) — builds plans for parts that may be sleeping, feeds conversation summaries without labeling whether the part actually spoke or was just discussed
2. **Chat prompts** (`systemPrompts.ts`) — mamka/kata prompts lack rules about not assuming part availability from discussion threads
3. **Context Prime** (`karel-did-context-prime`) — builds situational cache without distinguishing activity types in thread summaries
4. **Drive Write** (`karel-did-drive-write`) — writes card updates without validating part status from registry
5. **Task suggestions** in chat — Karel suggests tasks involving sleeping parts

### Root Cause

When Karel reads `did_threads`, each thread has a `sub_mode` field:
- `sub_mode = "cast"` → part spoke directly (CONFIRMED ACTIVE)
- `sub_mode = "mamka"` or `"kata"` → therapist discussed the part (NOT confirmed active)

Currently this distinction is ignored everywhere except cycle reports.

### Solution: 5 Files to Update

#### 1. `supabase/functions/karel-did-session-prep/index.ts`
- **Conversation summaries** (line ~243): Label each thread with `[PŘÍMÁ AKTIVITA]` or `[ZMÍNKA terapeutkou]` based on `sub_mode`
- **System prompt** (line ~287): Add DORMANCY GUARD rules:
  - Check `partReg.status` — if sleeping/dormant, warn therapist explicitly
  - Add rule: "If the part's status is 'sleeping', the plan MUST start with a section on activation strategy. Do NOT assume the part will be responsive."
  - Add rule: "Threads where sub_mode != 'cast' are therapist discussions ABOUT the part, not evidence the part is available"

#### 2. `supabase/functions/karel-chat/systemPrompts.ts`
- **Add global DID rule** (after line ~293, before mode-specific sections):
```
═══ KRITICKÉ PRAVIDLO: AKTIVITA vs. ZMÍNKA ═══
Karel MUSÍ rozlišovat:
- PŘÍMÁ AKTIVITA: Vlákno sub_mode="cast" = část přímo mluvila. Část je potvrzeně aktivní.
- ZMÍNKA: Vlákno sub_mode="mamka"/"kata" = terapeutka o části hovořila. Část NEMUSÍ být k dispozici.

Karel NESMÍ:
- Zadávat úkoly typu "pracuj přímo s X" pokud X je spící/dormantní
- Předpokládat že část je aktivní jen proto, že o ní terapeutka mluvila
- Plánovat sezení s částí bez ověření jejího statusu v registru

Pokud Karel NEVÍ zda je část aktivní či spící, MUSÍ SE AKTIVNĚ DOPTAT uživatele:
"Je [část] teď aktivní/přítomná? Nebo o ní mluvíš z perspektivy plánování?"
```

#### 3. `supabase/functions/karel-did-context-prime/index.ts`
- When building thread summaries, label each with activity type based on `sub_mode`
- Include `did_part_registry` status data in the context cache so Karel knows which parts are active/sleeping

#### 4. `supabase/functions/karel-did-session-prep/index.ts` (system prompt section)
- Add explicit dormancy check: if `partReg?.status === "sleeping"`, prepend warning to system prompt
- Add rule that session plans for sleeping parts must focus on activation/preparation strategies, not direct therapeutic work

#### 5. `supabase/functions/karel-chat/index.ts`
- In the task injection block (line ~131), include registry status for parts mentioned in tasks
- Add context: "Parts with status 'sleeping' cannot receive direct tasks"

### Technical Details

**Thread labeling pattern** (reusable across all functions):
```typescript
const activityLabel = (subMode: string) => 
  subMode === "cast" ? "PŘÍMÁ AKTIVITA" : "ZMÍNKA (pohled terapeutky)";

// In conversation summary building:
return `[${date}] [${activityLabel(t.sub_mode)}] (${t.sub_mode})\n${lastMsgs}`;
```

**Registry status injection** (for session-prep and context-prime):
```typescript
// Already fetched in session-prep as partReg
const dormancyWarning = partReg?.status !== "active" 
  ? `⚠️ VAROVÁNÍ: Část "${partName}" má status "${partReg?.status || 'neznámý'}". Nemusí být k dispozici pro přímou práci.`
  : "";
```

**Proactive questioning rule** (for chat):
```
Pokud z kontextu NENÍ zřejmé, zda je část aktivní:
Karel se MUSÍ zeptat: "Je [X] teď aktivní, nebo o ní mluvíš jako o spící části?"
Bez této informace Karel NESMÍ:
- Zapisovat záznamy do karty jako by šlo o přímý kontakt
- Navrhovat přímé terapeutické techniky
- Zadávat úkoly vyžadující přítomnost části
```

### Files to Edit
1. `supabase/functions/karel-did-session-prep/index.ts` — activity labels + dormancy guard
2. `supabase/functions/karel-chat/systemPrompts.ts` — global dormancy rules
3. `supabase/functions/karel-did-context-prime/index.ts` — labeled thread summaries + registry injection
4. `supabase/functions/karel-chat/index.ts` — registry status in task context

