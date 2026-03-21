

# Krok 2: Error Boundaries kolem DID panelů

## Problém
Pád jedné komponenty (např. DidSystemOverview) shodí celý dashboard. React nemá defaultní error handling pro renderovací chyby.

## Řešení

### 1. Nová komponenta `src/components/ErrorBoundary.tsx`
- Generic React class component (error boundaries vyžadují class component)
- UI: zaoblený box s ikonou varování, text "Něco se pokazilo", detail chyby (collapsed), tlačítko "Zkusit znovu" (reset error state)
- Props: `fallbackTitle?: string` pro kontext ("Panel přehledu selhal" apod.)

### 2. Úprava `src/components/did/DidDashboard.tsx`
Obalit každý hlavní panel Error Boundary:
- `DidSystemOverview`
- `DidDailySessionPlan`
- `DidTherapistTaskBoard` (celý wrapper s úkoly)
- `DidAgreementsPanel`
- `DidMonthlyPanel`
- `DidPulseCheck`
- `DidCoordinationAlerts`
- `DidSupervisionReport`
- `DidColleagueView`
- `DidSystemMap`

### 3. Úprava `src/pages/Chat.tsx`
Obalit `DidLiveSessionPanel` (~řádek 1904) a `DidDashboard` Error Boundary.

### Soubory
- `src/components/ErrorBoundary.tsx` (nový)
- `src/components/did/DidDashboard.tsx` (úprava — wrappy)
- `src/pages/Chat.tsx` (úprava — 2 wrappy)

Bez DB migrace. Čistě frontend změna.

