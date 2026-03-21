
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

# Další kroky (dosud neimplementované)

1. **Auto denní plán sezení 14:00** (cron + skóre naléhavosti + výběr části)
2. **Follow-up cyklus** (2h check + 24h timeout + zpětná vazba)
3. **Poradenský mód** (auto-switch při probíhajícím sezení)
4. **Mirror doladění** (pending záznamy do karet, urgentní notifikace)
5. **UI „Karlův přehled"** (připnuté karty sezení se stavy)
