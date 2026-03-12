

## Plán implementace – 3 úkoly

### 1. RefreshTrigger pro DidTherapistTaskBoard a DidAgreementsPanel

**Problém:** Po dokončení manuální aktualizace kartotéky (denní cyklus) ani po týdenním cyklu se tyto komponenty nerefreshují.

**Řešení:**
- `DidDashboard` zavede stav `refreshTrigger: number`, který inkrementuje v existujícím `useEffect` reagujícím na `isUpdating` přechod true→false
- Předá `refreshTrigger` jako prop do `DidTherapistTaskBoard` a `DidAgreementsPanel`
- Obě komponenty přidají `useEffect` na změnu `refreshTrigger` → zavolají `loadTasks()` / `loadData()`
- `DidAgreementsPanel` navíc inkrementuje lokální trigger po dokončení `handleRunWeekly`, aby se refresh propagoval i po týdenním cyklu

**Soubory:** `DidDashboard.tsx`, `DidTherapistTaskBoard.tsx`, `DidAgreementsPanel.tsx`

---

### 2. Session Prep – „Připrav mě na sezení s [část]"

**Nová edge funkce:** `karel-did-session-prep`
- Vstup: `{ partName: string }`
- Načte z Google Drive: kartu části (01_AKTIVNI_FRAGMENTY), terapeutický plán (05), dohody (06)
- Načte z DB: poslední vlákna dané části (did_threads), nedokončené úkoly (did_therapist_tasks), vzorce (karel-did-patterns data)
- AI (gemini-2.5-flash, streaming) vytvoří strukturovaný briefing:
  - Co se dělo v posledních rozhovorech
  - Na co navázat
  - Co sledovat (rizika, triggery z karty)
  - Doporučené metody a techniky
  - Relevantní úkoly a dohody

**Frontend:**
- Nová komponenta `DidSessionPrep.tsx` — dialog/panel s výběrem části (autocomplete z existujících part_name v did_threads) a streaming zobrazení briefingu
- Tlačítko na dashboardu vedle systémové mapy: „📋 Příprava na sezení"
- Alternativně: klik na část v systémové mapě → „Připrav sezení s [část]"

**Config:** Přidat `[functions.karel-did-session-prep]` do config.toml

---

### 3. Měsíční report s redistribucí do kartotéky

**Nová edge funkce:** `karel-did-monthly-cycle`
- Spouští se: pg_cron (1. den v měsíci v 10:00) + manuálně z UI
- Shromáždí data za posledních 30 dní:
  - Denní cykly (did_update_cycles, cycle_type=daily) — report_summary, cards_updated
  - Týdenní cykly (cycle_type=weekly) — report_summary
  - Aktivita částí (did_threads) — frekvence, poslední kontakt, počet zpráv
  - Úkoly (did_therapist_tasks) — splněné vs. nesplněné
  - Karty částí z Drive (aktuální stav)
  - Centrum dokumenty (Dashboard, Geografie, Mapa vztahů, Terap. plán, Dohody)
- AI analýza (gemini-2.5-pro pro komplexní reasoning):
  - Porovnání stavu systému: před 30 dny vs. teď
  - Počet aktivních/spících/varovných částí — změny
  - Frekvence komunikace — trendy
  - Splněné úkoly — efektivita
  - Změny ve vzorcích chování
  - **Návrhy redistribuce**: AI identifikuje co kam zapsat:
    - Změna statusu části (aktivní↔spící) → aktualizovat kartu
    - Nové poznatky o vnitřním světě → Geografie
    - Změny ve vztazích mezi částmi → Mapa vztahů  
    - Aktualizace terapeutického plánu → 05_Terapeuticky_Plan
    - Nové dohody/uzavřené dohody → 06_Terapeuticke_Dohody
    - Systémové změny → 00_Dashboard
- Karel provede zápis pomocí existujících Drive helper funkcí (batchUpdate/append)
- Uloží report do did_update_cycles (cycle_type="monthly")
- Odešle email s PDF přílohou (jspdf) pro supervizi
- PDF se zároveň uloží do kartotéky na Drive (nová složka 08_Mesicni_Reporty)

**Frontend:**
- Nová sekce na dashboardu pod týdenními cykly: „Měsíční přehledy"
- Tlačítko „Spustit měsíční analýzu" (s 30denním cooldownem)
- Zobrazení posledních 3 měsíčních reportů (expandovatelné)

**DB:** Žádné nové tabulky — použije existující `did_update_cycles` s `cycle_type = 'monthly'`

**Config:** Přidat `[functions.karel-did-monthly-cycle]` do config.toml

**pg_cron:** Nový job pro 1. den měsíce v 10:00

---

### Pořadí implementace
1. RefreshTrigger (rychlá oprava, základ pro další)
2. Session Prep (nová edge funkce + UI komponenta)
3. Monthly Cycle (nejkomplexnější — edge funkce s Drive zápisem + UI + cron)

