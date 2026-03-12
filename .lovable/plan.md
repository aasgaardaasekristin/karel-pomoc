

## Problém

Aktuálně existují **dva nezávislé polling mechanismy**, které zbytečně zatěžují UI:

1. **DidAgreementsPanel** — polluje DB každých 30 sekund (`setInterval`) pro stav týdenních cyklů
2. **DidDashboard** — při každém otevření spouští `loadDashboardData()`, který automaticky triggeruje denní zálohu pokud je starší 24h

Tvůj návrh je správný: polling by neměl běžet neustále. Měl by se aktivovat **jen při konkrétních událostech**.

## Plán opravy

### 1. Odstranit 30s interval polling z DidAgreementsPanel
- Smazat `setInterval` v `useEffect`
- Data se načtou **jednou** při mountu
- Refresh dat se provede **jen po**:
  - Kliknutí na tlačítko "Spustit týdenní cyklus" (po dokončení `handleRunWeekly`)
  - Když parent (Dashboard) signalizuje, že proběhl manuální update kartotéky (nový prop `onCycleFinished` nebo reaktivní refresh)

### 2. Odstranit auto-backup logiku z DidDashboard
- Smazat celý blok `needsBackup` (řádky 228-261), který automaticky spouští denní cyklus při každém otevření dashboardu
- Denní cyklus bude spouštěn **pouze**:
  - **pg_cron** (automaticky, jak je naplánováno)
  - **Manuálně** tlačítkem "Aktualizovat kartotéku" (`onManualUpdate`)
- Zachovat zobrazení `lastBackupTime` pro informaci, ale bez auto-triggeru

### 3. Refresh po manuálních akcích
- Po dokončení manuální aktualizace kartotéky (`isUpdating` přechod true→false) — už existuje, zachovat
- Po kliknutí "Spustit týdenní cyklus" — už existuje v `handleRunWeekly`, zachovat
- Žádný jiný automatický refresh

### Dopad
- UI přestane blikat a dělat zbytečné requesty
- Denní a týdenní cykly poběží jen když mají (cron nebo manuální tlačítko)
- Žádná ztráta funkčnosti — cron joby na serveru běží nezávisle na UI

