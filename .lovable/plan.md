

# FÁZE 1 — DID/Terapeut jako velitelské stanoviště
<lov-tool-use id="toolu_vrtx_011jxupcVmPGqj4akWsKnCZU" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidDashboard.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01GP8DaRERJxQUmqR5bKrxk9" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidContentRouter.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_011GviQkbc2aTSBLWndS6ChH" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidCrisisPanel.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_015EEyS7DqbUgJJrXNCSfeJs" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidCoordinationAlerts.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01VQLtBLzHAAunfJJxu4bgi6" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidDailySessionPlan.tsx\", \"lines\": \"150-460\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01DVbAj9Yx16PcVyPN5eqTRr" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidMeetingPanel.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01YCx9jSAGCc5RuJR4bUVir5" name="code--view" integration-id="code" data="{\"file_path\": \"src/pages/Chat.tsx\", \"lines\": \"850-960\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01MHNjCF6pyVqKiAiJD8nmb1" name="code--view" integration-id="code" data="{\"file_path\": \"supabase/functions/karel-daily-dashboard/index.ts\", \"lines\": \"1-150\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_0143Y73qATT2z6ZWFBi82jum" name="code--view" integration-id="code" data="{\"file_path\": \"supabase/functions/karel-did-meeting/index.ts\", \"lines\": \"1-200\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01E8QU1595bDdRKEptiGx5uG" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidDashboard.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01WAXKwPNSkyXqJJuLZY6pwQ" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidContentRouter.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01SWZ5KuxDQuUCeEeJueDFXD" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidCrisisPanel.tsx\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01CzmNRJ3dheMqRpSfiSMfuQ" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidCoordinationAlerts.tsx\"}">
</lov-tool-use>
I have enough context to present a focused plan. Let me also briefly check the daily-dashboard edge function and the meeting panel to confirm where rehydration / dedupe needs to happen.
<lov-tool-use id="toolu_vrtx_01KVUcWXJj4CraiBnWAzuMqS" name="code--view" integration-id="code" data="{\"file_path\": \"supabase/functions/karel-daily-dashboard/index.ts\", \"lines\": \"1-120\"}">
</lov-tool-use>

<lov-tool-use id="toolu_vrtx_01JscP8FdQsnvbiMoP4UgEjk" name="code--view" integration-id="code" data="{\"file_path\": \"src/components/did/DidMeetingPanel.tsx\", \"lines\": \"1-200\"}">
</lov-tool-use>
I have enough context now. The user explicitly asked me to "edit only" specific files and listed strict acceptance criteria. They expect a focused implementation plan, not more research. Let me present a tight plan.

<lov-plan>

# FÁZE 1 — DID/Terapeut jako velitelské stanoviště

## Co dnes brzdí dashboard

1. **`DidDashboard.tsx`** ukazuje krizovou cedulí jen přes globální `CrisisAlert` (sticky nahoře) + plain badge `hasCrisisBanner` — žádná komandní karta s "co dnes chybí / co Karel vyžaduje / 1-2 CTA".
2. **`DidCrisisPanel.tsx`** je archivní timeline panel (indikátory, diagnostický skór, 20 logů) — neukazuje „poslední zásah / čeká se na koho / další sezení / stav uzavření" jako oddělený detail.
3. **`DidDailySessionPlan.tsx`** prezentuje stale `generated` plány z minulých dní jako dnešní realitu (řádek 91 `firstPendingPlan`).
4. **`KarelDailyPlan.tsx`** má narrativ, ale chybí mu **4 strukturované sekce** (Dnes nově / Dnes horší / Dnes nepotvrzené / Dnes vyžaduje zásah) — to je srdce velitelského pohledu.
5. **`DidMeetingPanel.tsx`** ř. 56–69: při mountu se `seed`/`meetingTopic` může vytvořit **nová** porada místo rehydratace existující (pre-flight lookup chybí).
6. **`Chat.tsx`** ř. ~895 routing pro `meeting_topic` URL param nemá pre-flight lookup → duplikáty.
7. **`DidCoordinationAlerts.tsx`** ukazuje zprávy bez `owner / deadline / posledního updatu / důvodu`.
8. **`karel-daily-dashboard`** edge fn produkuje volný markdown — chybí strukturovaný JSON se 4 sekcemi pro velitelský pohled.
9. **`karel-did-meeting`** action `create` nemá server-side dedupe.
10. **`karel-did-auto-session-plan`**: chybí guard, aby se starý `generated` plán neproháněl jako dnešní.
11. **`karel-daily-refresh`** (orchestrátor): musí trigger novou výstupní strukturu z `karel-daily-dashboard` (sekce nově/horší/nepotvrzené/zásah).

---

## Plán oprav

### A. Velitelská krizová karta (top of dashboard)
**`DidDashboard.tsx`:** Nahradit dnešní `<CrisisAlert>` sticky banner kompaktní `<CommandCrisisCard>` zobrazující per-aktivní-krizi:
- část, stav (active / awaiting_feedback / ready_to_close), stáří posledního update (h)
- **Co dnes chybí:** computed z `useCrisisOperationalState` (`missingTodayInterview`, `missingTherapistFeedback`, `unansweredQuestionCount`)
- **Co Karel vyžaduje:** první pending CTA z karty
- **1-2 CTA tlačítka:** "Otevřít krizové vlákno" → `navigate(/chat?...)`, "Otevřít detail" → expand `<DidCrisisPanel>` v drawer/sheet

Žádný narativní text. Žádný old `summary` z `crisis_alerts`.

### B. Detail krize (`DidCrisisPanel.tsx`)
Přepsat na 6-sekční detail (čistá data, žádné progress baly bez kontextu):
1. **Poslední hodnocení** — z `crisis_karel_interviews` (poslední řádek, datum + skór)
2. **Poslední zásah** — z `crisis_session_logs` (poslední, kdo, výsledek)
3. **Výsledek** — `safety_ok / coherence_score / risk_signals`
4. **Čeká se na koho** — `closure_approved_by` diff vs. potřebných (hanka/kata), nebo `missingTherapistFeedback`
5. **Další sezení** — z `did_daily_session_plans` filtr `selected_part = crisis.part_name AND plan_date >= today`
6. **Stav uzavření** — `phase` + checklist co chybí pro `closing → closed`

Použít jako drawer/expand z velitelské karty, **ne** jako root komponenta.

### C. KarelDailyPlan — 4 nové sekce
**`KarelDailyPlan.tsx`:** Pod existující narrativ + recommendations přidat **strukturovaný 4-blok**:

- **🆕 Dnes nově** — nové části/threads s `created_at >= today` (z `did_threads` + `did_part_registry` `first_seen_at >= today`)
- **🔻 Dnes horší** — části kde `last_emotional_intensity` v `did_part_registry` se zhoršila vs. včera (porovnat `daily_metrics`) NEBO nové `crisis_alerts` se severity ≥ high vytvořené dnes
- **❓ Dnes nepotvrzené** — pending `did_pending_questions` s `directed_to ∈ {hanka, kata}` starší 24h bez odpovědi
- **⚡ Dnes vyžaduje zásah** — overdue `did_therapist_tasks` (priority high/urgent/critical) + krize bez dnešního interview/feedback

Každý řádek karty: `{ entity, owner, lastUpdate, reason, primaryCTA }`. Klik → `navigate()` na živý destination (vlákno/úkol/otázka/krizová karta).

Data zdroj: nová server odpověď `karel-daily-dashboard` (viz F).

### D. Persistovaný session-thread workflow
**`DidDailySessionPlan.tsx`** + **`KarelDailyPlan.tsx`** session recommendations:

Klik na "Otevřít sezení" → vždy:
1. Pre-flight lookup do `did_meetings` `where meeting_type='session_planning' AND part_name=X AND status='open' AND created_at > now()-24h`
2. Pokud existuje → `navigate(/chat?meeting={existingId}&therapist=hanka)`
3. Pokud neexistuje → invoke `karel-did-meeting` action `create` se `meeting_type='session_planning'` a session-recommendation seed
4. Po response → naviguj na `?meeting={newId}`

**`DidMeetingPanel.tsx`** ř. 56–69:
- Při mountu pokud `meetingTopic` ale ne `meetingId` → nejdřív `loadMeetings()` + filter podle topic+open+24h → pokud match, načti místo create
- Server state je single source of truth; lokální `activeMeeting` se hydrate jen z `loadMeeting(id)`
- Draft input (`hankaInput`, `kataInput`) persist do `localStorage` klíč `meeting-draft:{meetingId}:{therapist}`, restore při mount

**`Chat.tsx`** ř. ~895 routing: stejný pre-flight lookup pro `meeting_topic` URL param před routováním na `meetingSeed` flow.

**`karel-did-meeting/index.ts`** action `create`: server-side dedupe — před insertem hledat open meeting se stejným `(topic, user_id, created_at > now()-6h)`. Pokud existuje, vrátit existující.

### E. Stale session plan fix
**`DidDailySessionPlan.tsx`** ř. ~91:
- `firstPendingPlan` filtr `plan_date = today` (NOT `>= today` ani open-ended)
- `order created_at desc` (poslední dnes vytvořený)
- Crisis blok ř. ~409–423: zobrazit POUZE pokud existuje `did_daily_session_plans` se `selected_part = crisis.part_name AND plan_date = today`. Jinak kompaktní badge "🔴 ARTHUR — bez dnešního plánu" + CTA "Vygenerovat plán"

**`karel-did-auto-session-plan/index.ts`**: před insertem nového plánu zkontrolovat, zda dnešní plán pro stejnou part neexistuje (idempotence).

### F. Dashboard data API
**`karel-daily-dashboard/index.ts`**: rozšířit JSON output o strukturovaný blok pro 4 sekce + velitelskou krizi:

```json
{
  "command": {
    "crises": [{ partName, state, hoursStaleUpdate, missing[], requires[], ctas[] }]
  },
  "todayNew": [{ entity, owner, lastUpdate, reason, ctaPath }],
  "todayWorse": [...],
  "todayUnconfirmed": [...],
  "todayActionRequired": [...]
}
```

`KarelDailyPlan.tsx` přejde na invoke této edge fn (nebo nového lehkého `karel-daily-command-snapshot` pokud současný daily-dashboard je pomalý) + cache do `localStorage` (24h TTL klíč `karel-command:{userId}:{YYYY-MM-DD}`).

**`karel-daily-refresh/index.ts`**: zajistit, že po manuálním "Obnovit" se invaliduje cache + spustí jak `karel-daily-dashboard` tak `karel-did-overview-narrative` (pokud existuje).

### G. Koordinační alerty s owner/deadline/důvod
**`DidCoordinationAlerts.tsx`:** rozšířit `Alert` shape o `{ owner, deadline?, lastUpdate, reason }`. Zdroje:
- `overlap`: owner = obě, lastUpdate = nejnovější session_date, reason = "obě pracovaly s X"
- `intensity`: owner = doporučený therapist (z registry), lastUpdate = `updated_at`, reason = "intenzita 4/5"
- `overdue`: rozbalit batch na per-task řádky se `assigned_to`, `due_date / created_at + 5d`, reason = `task` text

Render: kompaktní řádek `{ icon | partName | owner badge | "před Xh" | "deadline DD.MM." | důvod | CTA }`.

### H. DidContentRouter cleanup
**`DidContentRouter.tsx`:**
- Odstranit `activeCrisisBanner` state (ř. 314–333) — krizová karta je v `DidDashboard` ne v thread routeru. Pokud uvnitř threadu má smysl mini badge, převést na čisté „⚠ X je v aktivní krizi → otevřít command card" link, žádný narativní text.
- Žádné odkazy na `DidSystemOverview` (per acceptance kritérium 9 — pokud někde zbylé importy, odstranit).

---

## Soubory

| Soubor | Akce | Risk |
|---|---|---|
| `DidDashboard.tsx` | nová `CommandCrisisCard`, layout reorder, drawer pro crisis detail | medium |
| `KarelDailyPlan.tsx` | invoke nového dashboard endpointu, render 4 sekcí + cache | medium |
| `DidDailySessionPlan.tsx` | filter `plan_date=today`, crisis blok jen pro dnešní plán, persistovaný session-thread CTA | medium |
| `DidCrisisPanel.tsx` | přepis na 6-sekční detail (poslední hodnocení / zásah / výsledek / čeká se / další sezení / stav uzavření) | medium |
| `DidMeetingPanel.tsx` | pre-flight lookup, draft persist, hydration purity | medium |
| `DidCoordinationAlerts.tsx` | rozšířit shape o owner/deadline/lastUpdate/reason | low |
| `DidContentRouter.tsx` | odstranit activeCrisisBanner, žádné DidSystemOverview | low |
| `Chat.tsx` (ř. ~895 segment) | pre-flight lookup pro `meeting_topic` URL | low |
| `karel-daily-dashboard/index.ts` | strukturovaný JSON output (command + 4 sekce) | medium |
| `karel-daily-refresh/index.ts` | invalidate cache + sequence dashboard refresh | low |
| `karel-did-auto-session-plan/index.ts` | guard proti duplicitnímu dnešnímu plánu | low |
| `karel-did-meeting/index.ts` | server-side dedupe v `create` (6h okno) | medium |

**Beze změny:** `useOperationalInboxCounts`, `useCrisisOperationalState`, `DidSprava`, task board, pending questions panel, realtime subscriptions.

## Akceptační kritéria

1. Top dashboard = velitelská karta (část / stav / stáří / co chybí / co Karel vyžaduje / 1-2 CTA), žádný archivní text.
2. Detail krize = 6 sekcí v drawer, oddělený od top karty.
3. KarelDailyPlan obsahuje 4 nové sekce (nově / horší / nepotvrzené / vyžaduje zásah).
4. Klik na doporučené sezení → persistovaný `did_meetings` thread (pre-flight + dedupe).
5. Návrat do meetingu → server-state hydration, žádný prázdný local state, draft restored.
6. Jasné stavy ve velitelské kartě i detailu.
7. Koordinační alerty s owner / deadline / lastUpdate / důvod.
8. Žádný stale generated plán jako dnešní realita.
9. Žádný `DidSystemOverview` ani staré krizové cedule.

