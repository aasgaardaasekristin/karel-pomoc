# FÁZE 3 — Sjednocení source-of-truth (FINAL, čeká na schválení)

## Cíl
Jeden mozek pro krize, dnešní sezení, akční frontu a goals.
Žádný nový monolit. Žádná druhá pipeline. Žádná druhá pravda.

---

## A. KANONICKÉ MODELY

| Doména | Kanonický model | Legacy (povolené role) |
|---|---|---|
| Krize | `crisis_events` (open phase filter) | `crisis_alerts` = notifikace/trigger/projekce |
| Dnešní sezení | `did_daily_session_plans` | `planned_sessions` = strategická projekce; `next_session_plan` = hint na kartě části |
| Akční fronta | `did_plan_items` | `did_therapist_tasks` = manuální adjunct (s `plan_item_id` link pro dedup) |
| Goals | `part_goals`, `strategic_goals` jako vstupní vrstva | nikdy ne přímý dnešní task/sezení dokud není materializované do canonical |

**Jednosměrné pravidlo**: canonical → legacy projection je povolená; legacy → canonical rozhodování zakázané.

---

## B. MIGRACE (minimální)

```sql
-- 1. Linkage manual task ↔ Karel-generated plan item (dedup)
ALTER TABLE did_therapist_tasks
  ADD COLUMN plan_item_id uuid REFERENCES did_plan_items(id) ON DELETE SET NULL;
CREATE INDEX idx_did_therapist_tasks_plan_item_id ON did_therapist_tasks(plan_item_id);

-- 2. Linkage daily session ↔ crisis event
ALTER TABLE did_daily_session_plans
  ADD COLUMN crisis_event_id uuid REFERENCES crisis_events(id) ON DELETE SET NULL;
CREATE INDEX idx_did_daily_session_plans_crisis_event_id ON did_daily_session_plans(crisis_event_id);

-- 3. Linkage meeting ↔ daily plan
ALTER TABLE did_meetings
  ADD COLUMN daily_plan_id uuid REFERENCES did_daily_session_plans(id) ON DELETE SET NULL;
CREATE INDEX idx_did_meetings_daily_plan_id ON did_meetings(daily_plan_id);
```

**Backfill**: jen vysoce jistá heuristika (part + Prague-day + open phase). Žádný agresivní backfill.

---

## C. CANONICAL RESOLVERS (jen server)

3 tenké shared moduly (každý < 100 LOC):

- `supabase/functions/_shared/canonicalCrisis.ts`
  - `OPEN_PHASE_FILTER` (jeden zdroj pravdy: `phase NOT IN ('closed','CLOSED')`)
  - `resolveActiveCrises(sb)`
  - `resolveCrisisIdForPart(sb, partName)`

- `supabase/functions/_shared/canonicalSession.ts`
  - `resolveTodaysSessions(sb, pragueDate)`
  - `resolvePrimarySessionForPart(sb, partName, pragueDate)`
  - `hydrateSessionMeeting(sb, dailyPlanId)`

- `supabase/functions/_shared/canonicalQueue.ts`
  - `resolveOperationalQueue(sb, pragueDate?)` → `{ primary: PlanItem[], adjunct: TherapistTask[] }`
  - dedup: skip `did_therapist_tasks` kde `plan_item_id IS NOT NULL`

**Frontend pravidlo (PŘITVRZENO)**:
- `src/lib/*` helpery smí být JEN tenké selektory nad už kanonickým server snapshotem
- ŽÁDNÁ paralelní resolver logika proti DB ve frontendu
- Frontend nesmí mít druhý mozek

---

## D. SERVER-SIDE SJEDNOCENÍ

### D1. Snapshot/dashboard funkce
- **`karel-daily-dashboard/index.ts`** — snapshot kanonický (crisis/session/queue), `command.queue` přidán, `todayActionRequired` jen z `resolveOperationalQueue`
- **`karel-daily-refresh/index.ts`** — kontextové bloky tasks/session/crisis kanonické

### D2. Writer-side linkage (P1 doplnění)
- **`karel-did-meeting/index.ts`** — při create/update meetingu plnit `daily_plan_id` (resolve podle dne + části + existujícího plánu)
- **`karel-did-auto-session-plan/index.ts`** — při create plánu plnit `crisis_event_id` přes `resolveCrisisIdForPart`

### D3. Degradace `planned_sessions` na projekci (PRAVIDLO, ne whitelist)
**Všechny** readery/writery, které dosud používají `planned_sessions` jako dnešní operativní pravdu, musí být opraveny. Po FÁZI 3 smí `planned_sessions` žít jen jako:
- strategická projekce
- compatibility vrstva
- legacy reporting

Známé callsites k revizi (rozšířený scope):
- `update-operative-plan/index.ts`
- `update-strategic-outlook/index.ts`
- `karel-did-daily-email/index.ts`
- `karel-did-daily-cycle/index.ts`
- `karel-did-monthly-cycle/index.ts`
- `karel-did-weekly-cycle/index.ts`
- `evaluate-crisis/index.ts`
- `approve-crisis-closure/index.ts`
- `generate-weekly-review/index.ts`
- `karel-did-supervision-report/index.ts`
- jakékoli další odhalené při auditu — všechny opravit, ne jen vyjmenované

Pravidlo: pokud `planned_sessions` zůstane jako write, musí být zápis **jednosměrně odvozený** z canonical (`did_daily_session_plans`) — nikdy zdroj rozhodnutí.

---

## E. UI SJEDNOCENÍ (rozšířený scope)

| Komponenta | Změna |
|---|---|
| `DidDashboard.tsx` | realtime `crisis_alerts` jen jako trigger refresh; krize/queue ze snapshotu |
| `KarelDailyPlan.tsx` | fallback krize přes canonical resolver; queue ze snapshotu |
| `DidDailySessionPlan.tsx` | krize z `crisis_events` (canonical), ne `crisis_alerts` |
| `DidSystemOverview.tsx` | count krize z `crisis_events` |
| `useCrisisOperationalState.ts` | sjednotit na `OPEN_PHASE_FILTER`; `crisis_alerts` jen enrichment |
| `DidPlanTab.tsx` | označit „Strategický plán / legacy projekce"; pokud má operativní akce, materializace MUSÍ jít do canonical (`did_daily_session_plans` / `did_plan_items`), ne do `planned_sessions` |
| `Chat.tsx` | deep-link `part_name` → resolve `crisis_event_id`; meeting deep-link přes `daily_plan_id` |
| `DidMeetingPanel.tsx` | rehydration a open/create přes `daily_plan_id` |
| **`DidCoordinationAlerts.tsx`** *(P1 doplnění)* | overdue alerts MUSÍ číst přes `resolveOperationalQueue` (canonical queue), ne raw `did_therapist_tasks` |
| **`PartQuickView.tsx`** *(P2 doplnění)* | `next_session_plan` smí zobrazit JEN jako hint/kontext části; jakékoli CTA nebo „dnešní" doporučení MUSÍ resolve-nout canonical daily session, ne číst hint napřímo |

---

## F. BACKWARD COMPATIBILITY (zpřesněno)

- Legacy tabulky NEMAZAT.
- Legacy write povolen JEN jako projection **odvozená** z canonical write.
- Legacy model NIKDY není rozhodovací autorita pro dnešní operativu.

| Legacy | Role po FÁZI 3 |
|---|---|
| `crisis_alerts` | notifikace / trigger / projekce |
| `planned_sessions` | strategická / legacy reporting projekce |
| `next_session_plan` (registry) | hint / kontext části |
| `did_therapist_tasks` | manuální adjunct (linkable přes `plan_item_id`) |
| `part_goals`, `strategic_goals` | goal input layer |

---

## G. SCOPE — soubory ke změně

**Migrace (1):** linkage + indexy + bezpečný backfill

**Nové shared (3):** `_shared/canonicalCrisis.ts`, `_shared/canonicalSession.ts`, `_shared/canonicalQueue.ts`

**Edge functions (writers + readers):**
- `karel-daily-dashboard/index.ts`
- `karel-daily-refresh/index.ts`
- `karel-did-meeting/index.ts` *(P1)*
- `karel-did-auto-session-plan/index.ts` *(P1)*
- `update-operative-plan/index.ts`
- `update-strategic-outlook/index.ts`
- `karel-did-daily-email/index.ts`
- `karel-did-daily-cycle/index.ts`
- `karel-did-weekly-cycle/index.ts`
- `karel-did-monthly-cycle/index.ts`
- `evaluate-crisis/index.ts`
- `approve-crisis-closure/index.ts`
- `generate-weekly-review/index.ts`
- `karel-did-supervision-report/index.ts`
- + jakékoli další, kde audit najde `planned_sessions` jako pravdu dneška

**UI:**
- `DidDashboard.tsx`
- `KarelDailyPlan.tsx`
- `DidDailySessionPlan.tsx`
- `DidSystemOverview.tsx`
- `useCrisisOperationalState.ts`
- `DidPlanTab.tsx`
- `Chat.tsx`
- `DidMeetingPanel.tsx`
- `DidCoordinationAlerts.tsx` *(P1)*
- `PartQuickView.tsx` *(P2)*

**Frontend selektory (volitelně, jen tenké):** `src/lib/canonicalSnapshot.ts`

---

## H. AKCEPTAČNÍ KRITÉRIA

- `crisis_events` je jediný kanonický krizový model
- `did_daily_session_plans` je jediný kanonický model dnešního sezení
- `did_plan_items` je kanonický model Karel-generated action items
- `did_meetings.daily_plan_id` je plněn writery, meeting není paralelní realita vedle daily planu
- `did_daily_session_plans.crisis_event_id` je plněn při auto-session-plan
- žádný screen/writer nepoužívá `planned_sessions` jako dnešní pravdu
- `DidCoordinationAlerts` čte canonical queue, ne raw `did_therapist_tasks`
- `PartQuickView` má `next_session_plan` jen jako hint, žádné CTA mimo canonical
- frontend `src/lib/*` jsou jen tenké selektory, žádný druhý resolver proti DB
- legacy write existuje jen jako jednosměrně odvozená projekce z canonical
- žádný nový monolit, žádná druhá pipeline

---

## I. ZBUDE DO FÁZE 4

- Smazání legacy tabulek (`planned_sessions`, `crisis_alerts`) až po měsících bezpečného provozu
- Reactive/analyst loop full integration do `did_plan_items`
- Vizuální vrstva (Bradavice/Jung tematika u kluků, music/avatary)
- Auth hardening
- Nový orchestration layer

---

## J. VÝSTUP PO IMPLEMENTACI

A. seznam změněných souborů
B. mapa kanonických modelů
C. role legacy vrstev
D. migrace + backfill
E. zbytek do FÁZE 4
F. unified diff
