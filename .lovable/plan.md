## P33.11 — Intelligent Playroom Program Execution Runtime

**Tvrdé pravidlo:** Stav fáze NESMÍ žít jen v system promptu nebo React state. Musí být perzistován v `did_active_sessions.metadata.playroom_state` a validován edge funkcí. AI pouze navrhuje značku, edge funkce ji validuje a provede přechod, klient zrcadlí stav.

---

### Architektura — rozdělení autority

```text
Edge function = source of truth pro phase, current_block_index, consecutive_stabilize_count
AI            = navrhuje child-facing text + jednu progress značku
Client        = zrcadlí stav ze serveru, renderuje UI
```

AI smí navrhnout pouze tyto značky (na konci své odpovědi):
`[PLAYROOM_PROGRESS:checkin|stay|advance|stabilize|resume|skip|stop]`

Edge funkce ji **parsuje, validuje, přijme/upraví/zamítne** podle pravidel níže. Značka se před odesláním dítěti **strippuje**. Dítě tag nikdy nevidí.

---

### Fáze (PlayroomPhase)

```ts
type PlayroomPhase = "checkin" | "program" | "stabilization" | "soft_close";
```

**PHASE 0 — checkin** (1–2 reakce dítěte)
- Karel jemně ověří: je přítomné to dítě? je baseline kompatibilní s programem? nedošlo k nečekané změně?
- Výsledek: `{ child_present, baseline: ok|fragile|crisis|unclear }`
- Pravidla: child_present=false → nestartovat; crisis → soft_close + signál terapeutce; fragile → start jemně; ok → start.
- Karel **nesmí** spustit blok 1 před dokončením check-inu.

**PHASE 1 — program** (default po check-inu)
- Karel vede přesně podle `therapeutic_program[current_block_index]`.
- Používá: `child_facing_prompt_draft`, intention, completion criteria, safety notes.
- Hardcoded šablony (sluníčko/vločka, „pošli slovo/symbol/ticho") jen jako poslední fallback při chybějícím kroku.
- Po splnění → značka `advance`, jinak `stay`.

**PHASE 2 — stabilization** (přechodný „bod navíc")
- Spustí se při: silné odbočce, emoční nestabilitě, vyhýbání, potřebě groundingu.
- Karel poskytne **jeden** stabilizující zásah, neopustí program.
- Po ověřené stabilizaci → `resume` na stejný `current_block_index`.
- **Nikdy** neadvancuje program jen proto, že proběhla stabilizace.

**PHASE 3 — soft_close** (jen když)
- Poslední blok dokončen, NEBO
- explicitní stop dítěte, NEBO
- terapeutická stop podmínka, NEBO
- crisis, NEBO
- `consecutive_stabilize_count >= 2` a další stabilizace by byla cyklus.

---

### Perzistentní stav

`did_active_sessions.metadata.playroom_state`:

```ts
interface PlayroomRuntimeState {
  version: "p33.11";
  approved_plan_id: string;
  approved_program_hash: string;
  phase: "checkin" | "program" | "stabilization" | "soft_close";
  current_block_index: number;
  checkin_turns_count: number;
  consecutive_stabilize_count: number;
  total_stabilize_count: number;
  last_progress_tag: string | null;
  last_transition_reason: string | null;
  program_started_at: string | null;
  last_updated_at: string;
  phase_history: Array<{
    at: string; from_phase: string; to_phase: string;
    from_block_index: number; to_block_index: number;
    ai_tag: string | null; accepted_tag: string; reason: string;
  }>; // bounded last 30
}
```

A snapshot schváleného programu (anti-mutace mid-flow):

```ts
metadata.playroom_approved_program_snapshot = {
  playroom_plan_id, approved_at, approved_by[],
  therapeutic_program: [...], program_hash
}
```

---

### Validace přechodů (edge)

`validatePlayroomProgressTransition({ currentState, aiProposedTag, childMessage, currentStep, approvedProgram })` — deterministická:

```text
checkin + checkin/stay         → checkin
checkin + advance/resume       → program (jen při dostatečném readiness signálu)
checkin + stop                 → soft_close

program + stay                 → program (stejný blok)
program + advance              → program (block_index + 1)
program + stabilize            → stabilization (stejný blok, count + 1)
program + stop                 → soft_close

stabilization + resume         → program (stejný blok, count = 0)
stabilization + stabilize      → povoleno jen když count < 2
stabilization + stabilize (>=2)→ vynucený skip nebo soft_close
stabilization + advance        → jen když je krok vyhodnocen jako neproveditelný a skip je bezpečnější
stabilization + stop           → soft_close
```

---

### AI prompt contract

System prompt Herny dostává **fakta o aktuálním stavu** (žádné JSON dumpy, žádné interní klíče):

```text
Aktuální fáze: program
Aktuální blok: 2 z 5
Aktuální schválený krok:
  - title:
  - child_facing_prompt_draft:
  - goal:
  - completion_criteria:
  - safety_notes:
Po sobě jdoucí stabilizace: 1
```

AI musí: psát jen child-facing text, držet se kroku, na konci přidat jednu značku, **nikdy** nezmiňovat `current_block_index`, `therapeutic_program`, `metadata`, JSON, tagy, implementaci.

---

### Soubory ke změně

**Backend (edge):**
- `supabase/functions/karel-chat/index.ts`
  - `loadApprovedPlayroomPlan` → vracet i `program_hash`
  - nová `loadOrInitPlayroomState(sessionId, approvedPlan)` — read/write do `did_active_sessions.metadata.playroom_state`
  - nová `validatePlayroomProgressTransition(...)` — deterministická
  - nová `applyPlayroomTransition(...)` — perzist do metadata + audit
  - přepsat `buildPlayroomRailReply` → číst `currentStep.child_facing_prompt_draft`, šablony jen jako last-resort
  - přepsat system prompt Herny — předávat strukturovaný stav, ne JSON dump
  - po AI odpovědi: extrahovat tag → validate → apply → strip tag → return child-safe text
- nová helper `supabase/functions/_shared/playroomProgramHash.ts` — stabilní hash schváleného programu
- audit: `karel_runtime_audit_logs` rozšířit metadata o `playroom_phase_*` (žádné raw child texty)

**Frontend (klient — jen mirror):**
- `src/components/did/DidKidsPlayroom.tsx`
  - **zúžit `blockedChildText`** — povolit přirozená slova `program / plán / blok / krok`, blokovat jen technické compound klíče (`playroom_plan`, `therapeutic_program`, `child_facing_prompt_draft`, `clinical_goal`, `theme_source`, `risk_assessment`, `forbidden_methods`, `currentBlockIndex`, `block_index`, `runtimeContext`, `metadata`, `phase_history`, `consecutive_stabilize_count`)
  - `buildRailReply` → číst `currentStep.child_facing_prompt_draft`, šablony jen last-resort
  - odebrat lokální autoritu `nextProgressState` → klient čte stav z odpovědi edge funkce (nový field `playroom_state` v response)
  - vykreslit `phase` a `current_block_index` jako read-only progress UI

**Migrace:** žádný schema change tabulky `did_active_sessions` (jen jsonb metadata).

---

### Testy

Nový soubor: `src/test/p33_11_playroomIntelligentProgramFlow.test.ts`

19 případů:
1. PHASE 0: první „ahoj" → check-in, ne blok 1.
2. PHASE 1 start: po validním check-inu Karel použije `child_facing_prompt_draft` bloku 0.
3. PHASE 1 advance: completion criteria splněna → block_index + 1.
4. PHASE 2 stabilize: off-topic dítě → stabilization, stejný block_index, count = 1.
5. Resume: po stabilizaci → program, stejný block_index, count = 0.
6. Anti-loop: po 2× stabilize → 3. tag stabilize zamítnut, vynucen skip nebo soft_close.
7. Stav perzistuje v `did_active_sessions.metadata.playroom_state`.
8. Reload session → stejná phase + index obnoveny ze serveru.
9. AI tag je strippován z child-visible textu.
10. Věta „Teď uděláme další krok našeho plánu, Tundrupku" projde `blockedChildText`.
11. Klíč `child_facing_prompt_draft` je blokován.
12. Klíč `therapeutic_program[0]` je blokován.
13. `buildRailReply` použije `child_facing_prompt_draft`, ne sluníčko.
14. Chybějící krok → bezpečný hardcoded fallback.
15. Snapshot programu se použije, ne live-mutated plan (úprava plánu mid-flow neovlivní běžící Hernu).
16. Soft close jen na konci nebo při safety stop.
17. Žádná raw klinická/interní metadata viditelná dítěti.
18. Transition audit zapsán bez raw child textu.
19. Klient zrcadlí phase ze serveru, lokální klient nesmí autoritativně rozhodnout phase.

```bash
bunx vitest run src/test/p33_11_playroomIntelligentProgramFlow.test.ts --reporter=basic
bunx vitest run --reporter=basic
```

---

### Acceptance gates (všechny musí být true)

```text
playroom_state_persisted_in_did_active_sessions_metadata
phase_survives_reload
consecutive_stabilize_count_survives_reload
approved_program_snapshot_created_on_start
runtime_uses_snapshot_not_live_mutating_plan
edge_validates_ai_progress_tags
ai_cannot_force_invalid_transition
max_two_consecutive_stabilize_enforced
ai_prompt_receives_current_step
child_never_sees_progress_tags
child_never_sees_internal_program_keys
rail_reply_uses_child_facing_prompt_draft
hardcoded_sunflake_only_last_fallback
client_blocked_text_filter_does_not_eat_program_words
technical_keys_still_blocked
playroom_phase_transition_audit_written
no_raw_child_text_in_transition_audit
p33_11_playroom_flow_tests_pass
full_vitest_pass
```

### Runtime proof (po deployi, jedno schválené Herna sezení s ≥3 kroky)

```text
runtime_playroom_uses_approved_program
runtime_playroom_phase_0_executed
runtime_playroom_program_step_uses_child_facing_prompt
runtime_playroom_stabilize_returns_to_same_block
runtime_playroom_no_infinite_stabilize_loop
runtime_playroom_tags_not_visible_to_child
runtime_blocked_text_filter_allows_program_words
runtime_approved_program_snapshot_used
runtime_phase_state_persisted_in_metadata
```

---

### Out of scope
- Schvalovací workflow porady, podpisy, sync `program_status` (P33.10.1).
- Drive containment (P33.10.2).
- UI dialogu „Plán dnešní herny — Tundrupek" (P33.10.1B).
- Karelovy obecné guardy mimo Hernu (cast/mamka/kata).
- P33.7C / P33.8 — beze změny.

### Verdikt
- Všechny gates true → `P33.11 = ACCEPTED`
- Jinak → `P33.11 = NOT_ACCEPTED, blocker=<přesný failující flag>`. STOP. Žádný další blok.

### Před implementací — dotaz
Plán **neimplementuju autonomně**. Potřebuji jen explicitní `SCHVÁLENO P33.11` a začnu PHASE-by-PHASE (nejprve perzistence + validace v edge, pak rail reply rewrite, pak klient mirror, pak testy, pak runtime proof).
