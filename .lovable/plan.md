# SEV-1 pass: `live_session_block_state_machine_and_ai_fallback_fix`

> **Tento pass není o toastu. Tento pass je o tom, že Karel v živém Sezení musí držet schválený program.**

## Dva propojené problémy

1. **Klinická regrese.** Karel v živém Sezení s gustíkem ztratil stav programu. Po odsouhlasení posledního bodu („měkké/klidné zakončení") sám zahájil už dokončenou aktivitu („Použijeme techniku kresby postavy… Pověz mi o tom člověku na obrázku…"), ignoroval výslovnou korekci terapeutky.
2. **Runtime crash.** `karel-block-followup` padá na prázdnou / nevalidní AI odpověď (`SyntaxError: Unexpected end of JSON input`), klient vyhodí Lovable runtime overlay → blank screen.

## Hlavní princip

**Volná AI nesmí rozhodovat o průchodu programem.** Backend je deterministický state-machine nad schváleným plánem; AI smí jen formulovat větu uvnitř povolené akce. AI output validator je **druhá** vrstva ochrany, ne primární řízení.

**Server je jediná autorita pro aktuální blok.** Klientská `current_block_index` / `current_block_title` jsou pouze hint. Pravda je vždy DB.

---

## 0. Audit reálného stavu (před úpravami)

Read-only SQL:

```sql
select
  p.id as plan_id, p.selected_part, p.status, p.lifecycle_status, p.started_at,
  p.plan_markdown ilike '%## Program sezení%' as has_program_section,
  left(p.plan_markdown, 2500) as plan_excerpt,
  lp.id as progress_id,
  lp.current_block_index, lp.current_block_status,
  lp.completed_blocks, lp.total_blocks, lp.items,
  lp.turns_by_block, lp.observations_by_block, lp.updated_at
from did_daily_session_plans p
left join did_live_session_progress lp on lp.plan_id = p.id
where p.started_at is not null
order by p.started_at desc limit 5;
```

Dolož: `active_plan_id`, `active_progress_id`, `current_block_index`, `current_block_title`, `current_block_status`, `completed_blocks`, `total_blocks`, zda poslední Karlův turn navrhuje aktivitu mimo aktuální blok.

---

## 1. `_shared/blockStateMachine.ts` (NOVÝ, čistě deterministický, unit-testovatelný)

```ts
type AllowedBlockAction =
  | "stay_on_current_block"
  | "await_therapist_result"
  | "mark_current_block_done"
  | "move_to_next_block"
  | "close_session"
  | "therapist_correction_realign";
```

Exportuje:
- `parseProgramBlocks(planMarkdown)` — robustní parser sekce `## Program sezení`. Pro každý blok: `{ index, title, kind, isFinal }`. `isFinal = true` pokud title matchuje `integrace`, `měkké/klidné/jemné ukončení`, `zakončení`, `uzavření`, `closure`, `final` (Unicode escapes pro diakritiku).
- `isTherapistAcknowledgement(text)` — krátké potvrzení (≤ 25 znaků, žádný otazník): „ano", „dobře", „rozumím", „jasně", „ok", „můžeme", „beru", „pokračuj", „provedeno".
- `detectTherapistCorrection(text)` — vzorce „to jsme už dělali", „postavu už jsme kreslili", „máš v tom zmatek", „teď má být jen", „takový je plán/domluva", „posledn[íi] bod", „zakonč[ít/it] / měkké zakončení".
- `detectOffPlanContent(aiText, ctx)` — vrací `{ offPlan, hits }`. Forbidden lex (Unicode escapes):
  - `nakresli`, `kresba postavy`, `kresb[ua]`, `postav[au]`, `pověz mi o tom člověku`, `co ten člověk dělá`, `kdo to je`, `další krok`, `jdeme na další`, `použijeme techniku`, `nový [úkol/test]`, `projektivní`.
  - V závěrečném bloku: zakázané vždy.
  - Mimo závěr: zakázané, pokud obsah patří do bloku, který je v `ctx.completedBlockTitles`.
- `decideAction({ ctx, lastTherapistMessage, isFirstAiTurn })` — vrací `{ action, allowedActions, forbiddenActions, reason }`.
- `deterministicFallbackForBlock(ctx, action)` — bezpečný `karel_text` v češtině pro každou akci (např. `await_therapist_result` → „Dobře, proveď prosím tento krok a pak mi napiš, jak gustík reagoval.").
- `validateBlockFollowupOutput(aiText, ctx)` → `{ ok, violations }`. Selže, pokud:
  - obsahuje název už dokončeného bloku jako novou aktivitu,
  - v závěrečném bloku obsahuje cokoliv z forbidden lexikonu,
  - oznamuje přechod na další blok, ale `action != move_to_next_block`,
  - referuje stimul/krok mimo aktuální blok.

Souborová organizace: čistý TypeScript bez Deno API (aby šel testovat v `vitest` i v `deno test`).

## 2. `karel-block-followup/index.ts` — refactor

### 2.1 Nové vstupy z klienta (jen jako hint, ne autorita)
`plan_id`, `progress_id`. Pokud chybí, server je dohledá z `live_session_id` v body, příp. fallback přes user_id + dnešní aktivní plán.

### 2.2 Server-side autoritativní načtení (před AI)
Service-role klient:
- `did_daily_session_plans` → `plan_markdown` → `parseProgramBlocks()`,
- `did_live_session_progress` → `current_block_index`, `current_block_status`, `completed_blocks`, `items`, `turns_by_block`.

Sestav `BlockGuardCtx`:
```ts
{
  plan_id, progress_id,
  current_block_index, current_block_title, current_block_kind,
  current_block_status, is_final_block,
  completed_blocks, total_blocks, completed_block_titles,
  last_therapist_message,
  allowed_actions, forbidden_actions,
}
```

**Mismatch detekce.** Pokud klientský `current_block_index/title` ≠ DB → server wins, audit do `did_live_session_progress.audit`:
```json
{ "event_type": "client_block_state_mismatch",
  "client_block_index": ..., "db_block_index": ..., "ts": ... }
```

### 2.3 Pre-AI guard (deterministická akce ještě před voláním AI)
- `isTherapistAcknowledgement(last)` → `action = await_therapist_result`, **bez AI volání**, vrať deterministický fallback. Block se nemění.
- `detectTherapistCorrection(last)` → `action = therapist_correction_realign`, **bez AI volání**, deterministická omluva + návrat k aktuálnímu bloku, žádné nové aktivity.
- `is_final_block` + free reply → AI smí běžet, ale do system promptu se vloží **HARD CLOSING DIRECTIVE** se seznamem `completed_block_titles` a explicitním zákazem nových diagnostických aktivit.

### 2.4 Robustní AI parsing (řeší crash)
Místo `await aiRes.json()`:
```ts
const rawAi = await aiRes.text();
if (!rawAi.trim()) {
  console.warn("[block-followup] empty AI body", { status: aiRes.status });
  return fallback200("AI_EMPTY_RESPONSE", ctx);
}
let aiData;
try { aiData = JSON.parse(rawAi); }
catch (e) {
  console.warn("[block-followup] invalid AI JSON", { snippet: rawAi.slice(0, 200) });
  return fallback200("AI_INVALID_JSON", ctx);
}
```

`fallback200(error, ctx)` → **HTTP 200**:
```json
{ "fallback": true, "error": "AI_EMPTY_RESPONSE",
  "karel_text": "<deterministicFallbackForBlock(ctx)>",
  "state_patch": { "preserve_current_block": true },
  "done": false }
```

### 2.5 Test-only force-paths (jen service-role)
Body může obsahovat:
- `test_force_ai_empty_body: true`,
- `test_force_ai_invalid_json: true`.

Povolené **pouze**, když request přišel s `service_role` klíčem (ověř přes `auth.getUser()` → admin role nebo bearer = `SUPABASE_SERVICE_ROLE_KEY`). Jinak ignorováno. Ne dostupné běžnému uživateli.

### 2.6 Post-AI validátor
Po extrakci `karel_text`:
```ts
const v = validateBlockFollowupOutput(aiText, ctx);
if (!v.ok) {
  await logHealth({ event_type: "off_plan_ai_block_rejected", violations: v.violations, ctx });
  return fallback200("OFF_PLAN_AI_BLOCK_REJECTED", ctx, { ai_output_replaced: true });
}
```

### 2.7 Audit do `did_live_session_progress.audit`
Po každém follow-upu:
```json
{ "block_followup_guard": {
    "current_block_index_before": 3, "current_block_index_after": 3,
    "current_block_status_before": "awaiting_therapist_result",
    "current_block_status_after": "awaiting_therapist_result",
    "action_taken": "await_therapist_result",
    "reason": "therapist_acknowledgement",
    "ai_output_replaced": false, "ts": "..."
} }
```

### 2.8 Fatal catch
- Auth fail → **401**.
- Bad input (chybí `part_name`, plan/progress neexistují) → **400**.
- AI/parsing/network/post-validator selhání → **200** s `fallback=true`.
```ts
catch (e) {
  console.error("[block-followup] fatal:", e);
  return new Response(JSON.stringify({
    fallback: true, error: "FOLLOWUP_FAILED",
    karel_text: "Karel teď nemůže bezpečně vytvořit další krok, ale sezení nespadlo. Drž aktuální blok a zkus to za chvíli znovu.",
    message: e?.message, done: false,
  }), { status: 200, headers: ... });
}
```

## 3. Klient — `BlockDiagnosticChat.tsx`

V `callFollowup`:
```ts
if ((data as any)?.fallback === true) {
  console.warn("[BlockDiagnosticChat] followup fallback:", data);
  const txt = String((data as any).karel_text ?? "Karel teď nemůže reagovat, zkus to znovu.");
  toast.warning(txt);
  setTurns(prev => [...prev, { from: "karel", text: txt, ts: new Date().toISOString() }]);
  // NEadvance, NEdone, NEcloseMsg
  return false;
}
```
Throw zachovat jen pro skutečné network/4xx/5xx.

Do invoke body přidat `plan_id`, `progress_id` (přes nové propsy z `LiveProgramChecklist`/`DidLiveSessionPanel`).

## 4. UI indikátor aktuálního bloku
V `LiveProgramChecklist`/`BlockDiagnosticChat` lidský header:
```
Aktuální bod programu: 4/4 — Integrace a měkké ukončení
Stav: čeká na reakci terapeutky
```
Beige parchment, žádné technické indexy.

## 5. Repair aktivního sezení (migrace)
Pro live progress, kde poslední Karlův turn obsahuje off-plan kresbu/postavu a `current_block_index < total_blocks - 1`, posuň na závěrečný blok, status `closing_pending`, do `audit` přidej `therapist_corrected_off_plan_ai_response = true`. Transcript ani `turns_by_block` se nemažou.

## 6. Testy (rozdělené)

### A. `_shared/blockStateMachine_test.ts` (Deno + vitest re-export)
- acknowledgement nezvyšuje block_index,
- detekce korekce,
- závěrečný blok → validátor zamítne kresbu,
- non-final blok → validátor pustí běžnou aktivitu,
- parser plánu identifikuje `is_final` u 4. bloku.

### B. `karel-block-followup` edge testy (`supabase--test_edge_functions`)
- `test_force_ai_empty_body=true` → 200 + `fallback=true` + `error="AI_EMPTY_RESPONSE"`,
- `test_force_ai_invalid_json=true` → 200 + `error="AI_INVALID_JSON"`,
- unauthorized → 401,
- bad input → 400,
- acknowledgement → bez AI volání, deterministický fallback.

### C. Frontend fallback (vitest)
- `BlockDiagnosticChat` na `fallback=true` nevolá `console.error` ani throw, volá `toast.warning`, nezvyšuje block.

### D. Live E2E DOM
- Otevři aktivní Sezení v browseru.
- Header: „Aktuální bod programu: 4/4 — …".
- Pošli `ano` → DOM `dom_off_plan_terms_after_ack_count = 0`.
- Pošli `To jsme už dělali. Teď má být jen měkké zakončení.` → DOM `dom_off_plan_terms_after_correction_count = 0`, obsahuje omluvu + návrat k závěru.

## 7. Akceptační tabulka

| Kontrola | Stav | Důkaz |
|---|---|---|
| Root cause state-loss confirmed | | SQL |
| Server is authority for current block (mismatch audited) | | log |
| AI empty body → 200 fallback (edge test) | | test |
| AI invalid JSON → 200 fallback (edge test) | | test |
| Unauthorized → 401, bad input → 400 | | test |
| Client fallback no overlay | | test |
| Acknowledgement does not advance block | | test |
| Final block blocks drawing/projective | | test |
| Therapist correction realigns | | test |
| Active session state repaired if needed | | SQL |
| DOM: current block shown | | DOM |
| DOM: "ano" does not trigger drawing | | DOM |
| DOM: correction returns to closing | | DOM |
| `block_state_machine_tests` | | passed |
| `edge_ai_fallback_tests` | | passed |
| `client_fallback_tests` | | passed |
| `live_session_dom_tests` | | passed |
| **Final result** | | accepted/not |

## 8. Akceptační pravidlo (zpřísněné)

Pass je `accepted` jen když:
1. aktuální blok je řízen DB state-machine, ne AI textem,
2. krátké „ano" neposune blok a nespustí novou aktivitu,
3. závěrečný blok blokuje kresbu/postavu/projektivní inquiry,
4. terapeutická korekce vrací Karla k aktuálnímu bloku,
5. AI empty/invalid JSON nevrací 500,
6. klient fallback nezpůsobí overlay,
7. aktivní sezení je opravené a auditované,
8. DOM E2E potvrzuje, že se kresba po „ano" ani po korekci znovu neobjeví,
9. všechny čtyři testovací sady prošly.

## Mimo rozsah
- Nemění se `_shared/clinicalPlaybooks.ts` prompt obsah.
- Nemění se schéma `did_daily_session_plans` ani `did_team_deliberations` (jen `did_live_session_progress.audit` jsonb append).
- Nemění se Herna (`did_kids_playroom`) ani `karel-part-session-prepare`.
