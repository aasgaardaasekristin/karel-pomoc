
# ✅ IMPLEMENTOVÁNO: Timezone + 3 Priority pro Plán sezení na dnes

## Co bylo uděláno

### 1. Timezone korekce
- Smazán starý cron job (ID 24, `0 5 * * *`)
- Vytvořeny dva nové joby:
  - **Winter** (ID 25): `0 5 * * *` (5:00 UTC = 6:00 CET, říjen–březen)
  - **Summer** (ID 26): `0 4 * * *` (4:00 UTC = 6:00 CEST, duben–září)
- Timezone guard v edge funkci: oba joby volají stejnou funkci, ale projde jen ten co padne do 5:00–7:00 Prague time

### 2. PRIORITA 1 — Eskalační mechanismus
- Nový sloupec `overdue_days` (integer, default 0) v `did_daily_session_plans`
- Před generováním nového plánu: UPDATE `overdue_days` pro všechny pending plány z minulých dní
- Části s overdue plánem dostávají +3 urgency bonus (temporary, v breakdown jako `overdue_escalation`)
- UI: červený badge `🔴 Čeká X dní` u plánů čekajících 2+ dní

### 3. PRIORITA 2 — Strukturovaný handoff Hanka → Káťa
- `session_lead = 'obe'` pro kombinované sezení
- Rozšířený systémový prompt generuje sekci `## 🤝 Předávací zpráva Hanka → Káťa`
- UI: badge `VEDE: Hanka + Káťa (kombinované)`

### 4. PRIORITA 3 — Prevence opakování
- Části s sezením v posledních 48h dostávají -5 urgency penalty
- V breakdown jako `recent_session: -5`

### 5. UI rozšíření
- Query načítá dnešní plány + starší pending plány z minulých dní
- Overdue badge s Prague timezone kalkulací
- Nové urgency labels: `overdue_escalation`, `recent_session`
