# FÁZE B — Briefing jako jediný operativní mozek dashboardu

Status: **ČEKÁ NA SCHVÁLENÍ.** Žádný kód neměnit, dokud uživatel nepotvrdí.

Tento plán nahrazuje předchozí FÁZI 3. Reaguje na 7 zpřesnění z poslední zprávy:
robustní item objekty, kanonické persistentní záznamy, suppression rules,
state machine pro `proposed_session`, kontextové „Zpět", napojení na `karelRender`,
explicitní source-of-truth mapa.

---

## A. Payload schema pro `did_daily_briefings.payload` (v2)

Migrace přidá sloupec `payload_version int not null default 2` (existující řádky dostanou `1` přes `UPDATE … WHERE payload_version IS NULL`). v1 zůstává čitelný (graceful fallback), v2 je nový kanonický tvar.

```ts
type BriefingItemKind =
  | "ask_hanka"
  | "ask_kata"
  | "decision"
  | "proposed_session";

type BriefingItemTarget =
  | { kind: "thread";        sub_mode: "mamka" | "kata" }      // ask_hanka / ask_kata
  | { kind: "deliberation";  deliberation_type: "team_task" | "session_plan" | "crisis" | "followup_review" | "supervision" }
  | { kind: "session_plan";  daily_plan_id: string | null };   // jen pro proposed_session po schválení

type BriefingItemStatus =
  | "draft"           // jen v briefingu, kanonický rec ještě neexistuje
  | "materialized"    // kanonický thread / deliberation existuje, ale neuzavřeno
  | "in_progress"     // signoff probíhá / sezení přiřazeno do dnes
  | "approved"        // signoff hotový / session_plan vytvořen
  | "executed"        // odpovědi došly / sezení proběhlo
  | "dismissed";      // tým bod zamítl

interface BriefingItem {
  id: string;                     // stable: hash(briefing_id + kind + index)
  kind: BriefingItemKind;
  target: BriefingItemTarget;
  title: string;                  // krátký rozhodovací název (UI heading)
  text: string;                   // 1–3 věty, Karlův hlas (renderováno přes karelRender)
  reason: string;                 // proč to musí padnout dnes
  part_name: string | null;       // o které části se mluví (může být null pro supervize)

  // Persistentní reference — vyplněné lazily při prvním kliknutí:
  thread_id: string | null;
  deliberation_id: string | null;
  daily_plan_id: string | null;   // jen u proposed_session po approve

  // Audit / dedup:
  source_keys: string[];          // např. ["task:abc-123", "obs:xyz", "crisis:Arthur"]
  source_task_ids: string[];      // konkrétní did_therapist_tasks.id, které tento bod „pohlcuje"
  status: BriefingItemStatus;
  resolved_at: string | null;     // ISO – kdy přešlo do executed/approved/dismissed
}

interface ProposedSessionItem extends BriefingItem {
  kind: "proposed_session";
  session_part_name: string;
  led_by: "Hanička" | "Káťa" | "společně";
  duration_min: number;           // 10–45
  agenda_outline: string[];       // např. ["0–5 stabilizace", "5–15 orientace", …]
  questions_for_team: string[];   // konkrétní otázky pro doladění před schválením
  kata_involvement: string | null;
}

interface BriefingPayloadV2 {
  version: 2;
  greeting: string;               // už NE jen text – generuje se přes karelRender voice (team_lead)
  last_3_days: string;
  lingering: string | null;
  closing: string;

  ask_hanka: BriefingItem[];      // max 3
  ask_kata:  BriefingItem[];      // max 3
  decisions: BriefingItem[];      // max 2 (+1 navíc jen pokud crisis)
  proposed_session: ProposedSessionItem | null;

  // Meta (pro suppression, ne pro render):
  promoted_task_ids: string[];    // sjednocení source_task_ids ze všech itemů → suppression klíč pro KarelDailyPlan
  promoted_part_names: string[];  // sjednocení part_name (lowercased) → suppression pro proposed_session
  waiting_for: string[];          // smí obsahovat JEN to, co není v žádném itemu (explicit dedup v promptu)
}
```

**Validace na server-side (po AI tool callu, před insert):**
- `decisions.length <= 2` jinak `+1` jen když existuje aktivní `crisis_events` pro `part_name` z toho navíc bodu.
- `ask_hanka` a `ask_kata` **nesmí mít stejný `text`** ani stejný `source_task_ids[0]` — server spadne s 422.
- `waiting_for[i]` **nesmí být substring** žádného `decisions[*].title` ani `ask_*[*].text`.
- `promoted_task_ids` = unique union všech `source_task_ids` → ukládá se do payload + duplikuje do nového sloupce `did_daily_briefings.promoted_task_ids text[]` (kvůli rychlým query/suppression bez deserializace JSON).

---

## B. Kanonické recordy / thready pro každý kind

Žádný `seed_brief` jako source of truth. Vždy persistentní záznam.

| BriefingItem.kind | Kanonický záznam (DB) | Tvorba | Klíč pro reopen |
|---|---|---|---|
| `ask_hanka` | **`did_threads`** s `sub_mode='mamka'`, `linked_briefing_id=<briefing.id>`, `linked_briefing_item_id=<item.id>` | Lazy: první klik → edge `karel-briefing-open-thread` zkontroluje, zda thread už existuje (přes `linked_briefing_item_id`), jinak vytvoří. Karlův úvodní message je vyrenderován přes `karelRender.renderTherapistAsk({ audience: "hanka", topTaskRaw: item.text + item.reason })`. | `did_threads.linked_briefing_item_id` (nový sloupec) |
| `ask_kata` | **`did_threads`** s `sub_mode='kata'`, totéž | Stejně, audience `"kata"` | totéž |
| `decisions` | **`did_team_deliberations`** s `linked_briefing_id`, `linked_briefing_item_id`, `deliberation_type=item.target.deliberation_type` | Lazy: první klik → existující funkce `karel-team-deliberation-create` rozšířena o `from_briefing: { briefing_id, item_id }`. AI dostane výřez briefingu jako kontext, vrátí poradu. Po insertu se zpětně updatuje `briefing.payload.decisions[i].deliberation_id` + `status='materialized'`. | `did_team_deliberations.linked_briefing_item_id` (nový sloupec, unique) |
| `proposed_session` (draft) | **`did_team_deliberations`** s `deliberation_type='session_plan'`, `linked_briefing_id`, `linked_briefing_item_id` | Stejně jako decisions, ale `karel_proposed_plan` se předvyplní z `agenda_outline + first_draft + questions_for_team` (jasně strukturované, nikoli volný text). | `did_team_deliberations.linked_briefing_item_id` |
| `proposed_session` (approved) | **`did_daily_session_plans`** s `linked_briefing_id`, `derived_from_deliberation_id` | Existující bridge v `karel-team-deliberation-signoff`: po 3× signoff (Hanka, Káťa, Karel) se vytvoří kanonický `did_daily_session_plans` a do briefing.payload.proposed_session se zapíše `daily_plan_id` + `status='approved'`. | `did_daily_session_plans.derived_from_deliberation_id` |
| `proposed_session` (live) | **`did_live_sessions`** (existující) s `daily_plan_id` | Klik na „Zahájit" v `DidDailySessionPlan`. Briefing item dostane `status='executed'`. | `did_live_sessions.daily_plan_id` |

**Nové sloupce (migrace):**
```sql
ALTER TABLE did_daily_briefings 
  ADD COLUMN payload_version int NOT NULL DEFAULT 2,
  ADD COLUMN promoted_task_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN promoted_part_names text[] NOT NULL DEFAULT '{}';

ALTER TABLE did_threads
  ADD COLUMN linked_briefing_id uuid REFERENCES did_daily_briefings(id) ON DELETE SET NULL,
  ADD COLUMN linked_briefing_item_id text;        -- BriefingItem.id (hash, ne FK)
CREATE UNIQUE INDEX idx_did_threads_briefing_item 
  ON did_threads(linked_briefing_item_id) 
  WHERE linked_briefing_item_id IS NOT NULL;

ALTER TABLE did_team_deliberations
  ADD COLUMN linked_briefing_id uuid REFERENCES did_daily_briefings(id) ON DELETE SET NULL,
  ADD COLUMN linked_briefing_item_id text;
CREATE UNIQUE INDEX idx_did_delib_briefing_item 
  ON did_team_deliberations(linked_briefing_item_id) 
  WHERE linked_briefing_item_id IS NOT NULL;

ALTER TABLE did_daily_session_plans
  ADD COLUMN linked_briefing_id uuid REFERENCES did_daily_briefings(id) ON DELETE SET NULL,
  ADD COLUMN derived_from_deliberation_id uuid REFERENCES did_team_deliberations(id) ON DELETE SET NULL;
```

`linked_briefing_item_id` je **text** (hash), ne UUID FK na pole v JSONB — kvůli stabilní identifikaci napříč regenerací briefingu.

---

## C. Suppression rules (anti-duplicita v dashboardu)

Briefing aktivně potlačuje cokoli, co duplikuje jeho obsah níže.

### C1. Suppression v `KarelDailyPlan` (operativní fronta)

Komponenta dostane `suppressedTaskIds: Set<string>` a `suppressedPartNames: Set<string>` z briefingu (přes prop, čte se z `did_daily_briefings.promoted_task_ids` + `promoted_part_names` — DB sloupce, ne JSON deserialize).

Pravidla:
1. Pokud `task.id ∈ suppressedTaskIds` → **task se vůbec nerenderuje** v sekci „Dnes vyžaduje zásah".
2. Pokud `task` je „check-in s {part}" a `part.toLowerCase() ∈ suppressedPartNames`, kde `briefing.proposed_session.part_name === part` a `proposed_session.status ∈ {draft, materialized, in_progress, approved}` → suppress.
3. Sekce „Káťo, potřebuji od tebe" v `KarelDailyPlan` se **úplně skrývá** (bool prop `hideTherapistAskSections={true}`), když `briefing.payload.ask_kata.length > 0`. Stejně Hanička. (Zabrání rozporu „v briefingu jsou kultivované asks, dole jsou robotické.")
4. Sekce „Společná porada — řešíme spolu" je **už pryč** (předchozí pass).

### C2. Suppression v `TeamDeliberationsPanel`

1. Pokud `deliberation.linked_briefing_id === currentBriefing.id` → vyrenderuje se pod nadpisem **„Z dnešního Karlova přehledu"**, ne v generic listu.
2. Generic list ukazuje jen porady, které **nemají** `linked_briefing_id` z dnešního briefingu (= ručně svolané nebo z minulých briefingů).

### C3. Suppression v `DidDailySessionPlan`

1. Pokud `briefing.payload.proposed_session.status ∈ {draft, materialized, in_progress}` a `did_daily_session_plans` pro dnešek **NEexistuje** → komponenta ukáže banner **„Návrh dnešního sezení je v poradě týmu"** s tlačítkem „Otevřít poradu" (vede do existující deliberation), nikoli „Vygenerovat plán".
2. Tlačítko „Vygenerovat plán" je dostupné jen když `proposed_session === null` v dnešním briefingu (= AI nenašla kandidáta a tým chce ručně přidat).
3. Pokud `proposed_session.status === 'approved'` a `daily_plan_id` existuje → ukazuje schválený plán (jak je teď), bez briefing banneru.

### C4. Render fallback pro v1 payload

Pokud `briefing.payload_version !== 2` → `DidDailyBriefingPanel` vyrenderuje text-only verzi (jak je teď), bez click handlerů. Žádné suppression rules se neaplikují (nemáme `promoted_task_ids`). Tím se zachová zpětná kompatibilita pro existující řádky.

---

## D. State machine pro `proposed_session`

```
                           (briefing generated by cron / manual)
                                          │
                                          ▼
                                      ┌────────┐
                                      │ draft  │  ← jen v briefing.payload, žádný DB rec
                                      └────────┘
                                          │ první klik „Otevřít poradu k sezení"
                                          ▼
                                  ┌──────────────┐
                                  │ materialized │  ← did_team_deliberations rec vznikl
                                  └──────────────┘
                                          │ Hanička/Káťa/Karel signují (postupně)
                                          ▼
                                  ┌──────────────┐
                                  │ in_progress  │  ← awaiting_signoff (≥1 podpis, <3)
                                  └──────────────┘
                                          │ 3. podpis = approved
                                          ▼
                                  ┌──────────────┐
                                  │  approved    │  ← did_daily_session_plans rec vznikl,
                                  └──────────────┘     daily_plan_id zpět do briefingu
                                          │ klik „Zahájit" v DidDailySessionPlan
                                          ▼
                                  ┌──────────────┐
                                  │  executed    │  ← did_live_sessions rec vznikl/uzavřen
                                  └──────────────┘
                                          │
                                          ▼
                                       (konec)

  Boční přechod (kdykoli z draft/materialized/in_progress):
                                          │ tým rozhodne „nepřibírat dnes"
                                          ▼
                                  ┌──────────────┐
                                  │  dismissed   │  ← briefing item.status, žádný kanon. rec
                                  └──────────────┘
```

**Invariant:** Pro daný kalendářní den smí existovat **maximálně jeden** `proposed_session` per briefing, **maximálně jedna** session_plan deliberation s `linked_briefing_id` z dnešního briefingu, a **maximálně jeden** `did_daily_session_plans` s `derived_from_deliberation_id` z té deliberation. Vynuceno unique indexy:

```sql
CREATE UNIQUE INDEX idx_one_session_per_briefing
  ON did_team_deliberations(linked_briefing_id, deliberation_type)
  WHERE deliberation_type = 'session_plan' AND status NOT IN ('dismissed', 'archived');

CREATE UNIQUE INDEX idx_one_plan_per_deliberation
  ON did_daily_session_plans(derived_from_deliberation_id)
  WHERE derived_from_deliberation_id IS NOT NULL;
```

Status transitions řídí edge funkce, ne UI:
- `karel-briefing-open-deliberation` (nový endpoint, společný pro decisions i proposed_session): `draft → materialized`
- `karel-team-deliberation-signoff` (existující): `materialized → in_progress → approved`
- `karel-session-finalize` (existující): `approved → executed` (po klik „Zahájit")

---

## E. Napojení na `karelRender` (žádný robotický intro text)

Všechny intro texty pro nově otevřené thready / poradní místnosti **musí** projít shared `karelRender` voice layer. Žádné staré task templaty.

| Místo | Volání | Výsledek |
|---|---|---|
| `ask_hanka[i].text` při generování briefingu (server) | `_shared/karelRender.renderTherapistAsk({ audience: "hanka", topTaskRaw: aiRawAsk })` | Kultivované „Haničko, hlavní věc na dnes je …" — ne raw `HIGH: [RECOVERY]` ani `Krátký check-in s …`. |
| `ask_kata[i].text` totéž | totéž s `audience: "kata"` | totéž pro Káťu |
| `decisions[i].text` (při generování) | `_shared/karelRender.renderCoordinationAlertText({ ownerRaw: "team", topicRaw: title, reasonRaw: reason })` → výstup → uloží se do payload | Krátká decisional věta, ne backlog formulace |
| Karlův úvodní `messages[0]` v `did_threads` při lazy-create | server `karel-briefing-open-thread` zavolá `renderTherapistAsk` znovu, ale s rozšířeným kontextem (`item.text + "\n\n" + item.reason + "\n\n" + lingering kontext z briefingu`) | Konzistentní hlas mezi briefingem a otevřeným vláknem |
| `karel_proposed_plan` v deliberation z `proposed_session` | server `karel-briefing-open-deliberation` složí strukturovaný plan: `agenda_outline` (bullet list, ne próza) + `first_draft` (renderováno přes `renderKarelBriefing` s hint `team_lead`) + `questions_for_team` (každá otázka samostatný řádek pro inline odpověď) | Není to dlouhý odstavec, ale připravený rozhodovací rámec |
| `initial_karel_brief` v deliberation z `decisions` | totéž, ale bez `agenda_outline` | totéž |
| `greeting` v briefingu (server, před insert) | `_shared/karelRender.buildGreeting("team", new Date())` — nahradí cokoli, co AI vyplodila | Vždy správný čas dne („Dobré ráno/odpoledne/večer, Haničko a Káťo.") |

**Audit guard:** každý vyrenderovaný text projde `auditHumanizedText()` — pokud obsahuje zakázané prefixy (`HIGH:`, `[RECOVERY]`, `critical krize:` …), insert spadne s 422 a do `ai_error_log` se zapíše violation. Briefing se NEinsertne v hadrovém stavu.

---

## F. Kontextové „Zpět" (origin-aware navigation)

Místo `sessionStorage.karel_return_to` (1 globální slot) → **stack** v sessionStorage.

```ts
// src/lib/navigationStack.ts (nový, ~40 LOC)
type NavOrigin =
  | { kind: "dashboard" }
  | { kind: "briefing"; briefing_id: string }
  | { kind: "deliberations_panel" }
  | { kind: "approved_session"; daily_plan_id: string };

push(origin: NavOrigin): void
pop(): NavOrigin | null
peek(): NavOrigin | null
```

Pravidla:
- Klik na `ask_hanka[i]` v briefingu → `push({ kind: "briefing", briefing_id })` → navigate do chatu Hanička.
- `ChatHeader.ArrowLeft` v sub-modu mamka/kata → `pop()` → pokud `kind === "briefing"` → `setDidFlowState("terapeut")` (= Karlův přehled). Pokud `null` → defaultní `setDidSubMode(null)`.
- Klik na `decisions[i]` → `push({ kind: "briefing", briefing_id })` → otevřít `DeliberationRoom` modal. Zavření modalu → `pop()`.
- Klik „Otevřít poradu" v `TeamDeliberationsPanel` → `push({ kind: "deliberations_panel" })` → modal. Zavření → `pop()`.
- Klik „Zahájit" v `DidDailySessionPlan` → `push({ kind: "approved_session", daily_plan_id })` → live-session. Tlačítko „Ukončit/Zpět" v live → `pop()` → vrátí na schválený plán, ne do dashboardu.

---

## G. Source-of-truth mapa (explicitní)

| Doména | Kanonický record (jediný zdroj pravdy) | Co NENÍ zdroj pravdy |
|---|---|---|
| Denní briefing | `did_daily_briefings` (latest, `is_stale=false`, dnes) | jakýkoli text v `KarelDailyPlan`, hardcoded narativy |
| Individuální ask pro Haničku | `did_threads` s `sub_mode='mamka'`, `linked_briefing_item_id=<id>` | `did_therapist_tasks` (ty zůstávají jen pro tasks, které briefing **NEpovýšil**) |
| Individuální ask pro Káťu | `did_threads` s `sub_mode='kata'`, `linked_briefing_item_id=<id>` | totéž |
| Týmová porada | `did_team_deliberations` (volitelně `linked_briefing_id` pokud z briefingu) | žádné lokální „buildMeetingSeed" v `KarelDailyPlan` (už pryč) |
| Dnešní navržené sezení (draft) | `did_team_deliberations` s `deliberation_type='session_plan'`, `linked_briefing_id`, status ≠ approved/dismissed | `next_session_plan` v registry (jen hint), `planned_sessions` (legacy projekce) |
| Dnešní schválené sezení | `did_daily_session_plans` s `derived_from_deliberation_id`, `session_date=today` | totéž |
| Live běžící sezení | `did_live_sessions` s `daily_plan_id` | totéž |
| Operativní fronta tasks | `did_plan_items` (Karel-generated, kanonické) + `did_therapist_tasks` (manuální adjunct) | text v briefingu (briefing tasks **promotuje** do svých itemů, neztrácí, ale suppresuje render) |

---

## Soubory ke změně (cca 9, žádný nový monolit)

| Soubor | Co se mění |
|---|---|
| **migrace** (nová) | sloupce z B (linked_*, payload_version, promoted_*, derived_from_deliberation_id), unique indexy z D |
| `supabase/functions/karel-did-daily-briefing/index.ts` | tool schema → v2 (BriefingItem objekty), validace + `karelRender` na server-side, výpočet `promoted_task_ids` / `promoted_part_names`, force greeting přes `buildGreeting` |
| `supabase/functions/_shared/karelRender/template.ts` | nová pomocná `renderProposedSessionPlan({ first_draft, agenda_outline, questions_for_team })` (mirror i v `src/lib/karelRender/template.ts`) |
| `supabase/functions/karel-briefing-open-thread/index.ts` (nová, ~80 LOC) | lazy-create `did_threads` z `ask_*` itemu; idempotent přes `linked_briefing_item_id` |
| `supabase/functions/karel-briefing-open-deliberation/index.ts` (nová, ~100 LOC) | lazy-create `did_team_deliberations` z `decisions` nebo `proposed_session`; idempotent; rozšíření `from_briefing` |
| `supabase/functions/karel-team-deliberation-signoff/index.ts` | po 3× signoff session_plan → vytvořit `did_daily_session_plans` s `derived_from_deliberation_id`, zpětně updatovat briefing item status='approved' a `daily_plan_id` |
| `src/components/did/DidDailyBriefingPanel.tsx` | render BriefingItem objektů, click handlery → invoke nových edge funkcí, navigationStack push, v1 fallback |
| `src/components/did/KarelDailyPlan.tsx` | čte `briefing.promoted_task_ids` + `promoted_part_names` → suppress filter; nové prop `hideTherapistAskSections` (default true když briefing v2 existuje) |
| `src/components/did/TeamDeliberationsPanel.tsx` | dvě sekce: „Z dnešního přehledu" a „Ostatní porady"; group by `linked_briefing_id` |
| `src/components/did/DidDailySessionPlan.tsx` | banner „Návrh je v poradě týmu" + suppress „Vygenerovat plán" když `proposed_session.status ∈ {draft, materialized, in_progress}` |
| `src/components/did/DidContentRouter.tsx` | `ArrowLeft` čte `navigationStack.pop()` místo defaultního `setDidSubMode(null)` |
| `src/lib/navigationStack.ts` (nová) | sessionStorage stack — push/pop/peek |

---

## Co se NEmění (záměrně, mimo scope)

- `useTeamDeliberations` hook — beze změny, jen panel ho jinak grupuje.
- `DeliberationRoom` modal — beze změny (signoff workflow).
- `did_plan_items` / `did_therapist_tasks` schema — beze změny.
- Žádné mazání legacy tabulek (to bylo a zůstává v FÁZI 4).

---

## Akceptační kritéria

1. Dashboard má **jednu** sekci „Karlův přehled" (DidDailyBriefingPanel), žádný druhý narativní blok níže.
2. Klik na `ask_hanka[i]` otevře persistentní `did_threads` rec (idempotent — druhý klik otevře tentýž thread).
3. Klik na `decisions[i]` otevře persistentní `did_team_deliberations` rec (idempotent).
4. `KarelDailyPlan` nerenderuje žádný task, jehož `id` je v `briefing.promoted_task_ids`.
5. `KarelDailyPlan` nerenderuje sekce „Káťo/Haničko, potřebuji od tebe", když briefing v2 má neprázdné `ask_*`.
6. `DidDailySessionPlan` ukáže banner „v poradě" místo „Vygenerovat plán", když existuje session_plan deliberation z dnešního briefingu.
7. `proposed_session.status` se aktualizuje při: open deliberation (→ materialized), 1. signoff (→ in_progress), 3. signoff (→ approved + daily_plan_id), klik Zahájit (→ executed).
8. „Zpět" z otevřeného briefing-thread vrací do dashboardu (= Karlův přehled), ne o úroveň níž.
9. Žádný intro text v nově otevřeném threadu/poradě nesmí obsahovat raw prefixy (`HIGH:`, `[RECOVERY]` …) — auditováno přes `auditHumanizedText`.
10. v1 briefingy (existující řádky) se renderují bez click handlerů (graceful fallback).

---

## Implementační pořadí (po schválení)

1. **Migrace** (sloupce + unique indexy) — vyžaduje user approve přes migration tool
2. **Server**: `karelRender` rozšíření → `karel-did-daily-briefing` v2 → 2 nové edge funkce → signoff bridge update
3. **UI**: `DidDailyBriefingPanel` v2 render + handlers → `KarelDailyPlan` suppress → `TeamDeliberationsPanel` group → `DidDailySessionPlan` banner → `DidContentRouter` ArrowLeft + `navigationStack`
4. **Verify**: `tsc --noEmit`, test 1 force-regenerate briefingu, manuální klik scenarios (ask → thread idempotency, decision → deliberation idempotency, signoff → session_plan, ArrowLeft origin), grep regex pro raw prefixy ve výstupu
5. **Final**: unified diff

---

## Otevřené otázky před implementací

Žádné — všech 7 zpřesnění je adresováno (A=schema, B=kanonické rec, C=suppression, D=state machine, E=karelRender, F=back nav, G=source-of-truth mapa).

Čekám na **schválení tohoto plánu**, pak jdu rovnou do migrace + implementace v pořadí výše.
