
# Implementováno: 4-listový DID_Therapist_Tasks

## Co bylo uděláno

### 1. DB migrace
- Přidán sloupec `task_tier` (text, NOT NULL, default 'operative') do `did_therapist_tasks`
- Povolené hodnoty: 'operative', 'tactical', 'strategic'

### 2. MODE I v `karel-did-drive-write` – přepsáno na 4 listy
- **Operativní**: ID, KOMU, ÚKOL, DETAIL, PRIORITA, STAV, DATUM, DEADLINE, ČÁST, POZNÁMKA
- **Taktické**: ID, KOMU, ÚKOL, METODA_TECHNIKA, DEADLINE, ČÁST, ZDROJ, STAV
- **Strategické**: ID, CÍL, ČÁST, METODA, OBZOR, STAV, POSLEDNÍ_AKTUALIZACE
- **Archiv**: ID, KOMU, ÚKOL, STAV, DATUM_VYTVORENI, DATUM_SPLNENI, POZNÁMKA

### 3. Auto-archivace
- Operative tasks s status != in_progress starší 14 dní → automaticky přesunuty do Archiv + DB update

### 4. Legacy sheet cleanup
- Po zápisu do 4 nových listů se staré listy (Hlavní, Legenda, Rezerva) automaticky smažou

### 5. Weekly-cycle task_tier
- `insertTask` v weekly-cycle nyní přijímá `tier` parametr (default 'tactical')

---

# Implementováno: Auto denní plán sezení (14:00)

## Co bylo uděláno

### 1. DB tabulka `did_daily_session_plans`
- plan_date, selected_part, urgency_score, urgency_breakdown, plan_markdown, plan_html
- therapist, status, distributed_drive, distributed_email
- UNIQUE(user_id, plan_date) – max 1 plán/den

### 2. Edge funkce `karel-did-auto-session-plan`
- **Skóre naléhavosti**: crisis(+5), nightmares(+4), dysregulation(+3), pending_tasks(+2), recent_activity(+2), dormant_7d(+1)
- **48h stabilizace**: pokud žádná část nebyla aktivní 48h → stabilizační plán
- **Fallback**: pokud žádná část nemá skóre > 0, vybere nejdéle neviděnou
- **Perplexity rešerše** pro vybranou část
- **Drive čtení**: karta části + operativní plán
- **AI generace**: 60min plán (Gemini 2.5 Flash)
- **Distribuce**: zápis do DB, Drive (05_Operativni_Plan), vytvoření operativního úkolu

### 3. Cron job
- `auto-session-plan-1350` – spouští se 11:50 UTC (13:50 CET/CEST)
- 10 minut před denním emailem (14:00)

### 4. Integrace do denního emailu
- `karel-did-daily-email` načítá `did_daily_session_plans` pro dnešek
- Plán je součástí dat pro AI generaci emailu
- Oba emaily (Hanka + Káťa) obsahují sekci "Plán sezení na dnes"

### 5. UI komponenta `DidDailySessionPlan`
- Zobrazuje dnešní plán v dashboardu (mezi Karlův přehled a Úkoly)
- Urgency badges s breakdown
- Rozbalitelný markdown plán
- Tlačítko "Vygenerovat" pro manuální spuštění

---

# Další kroky (dosud neimplementované)

1. **Follow-up cyklus** (2h check + 24h timeout + zpětná vazba)
2. **Poradenský mód** (auto-switch při probíhajícím sezení)
3. **Mirror doladění** (pending záznamy do karet, urgentní notifikace)
4. **Konzistence karta↔sheet↔plán** (automatická kontrola)
5. **UI „Karlův přehled"** – připnuté karty sezení se stavy
