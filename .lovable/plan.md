

# FÁZE 3 — Záložka „Asistence" v Kartotéce

3 soubory, ~65 řádků, žádná DB migrace, žádné nové závislosti.

## 1. `src/pages/Kartoteka.tsx` (~20 řádků)

- Import `LiveSessionPanel`
- Přidat stav `activeTab` pro controlled Tabs
- `sm:grid-cols-7` → `sm:grid-cols-8`
- Přidat TabsTrigger `assistance` + TabsContent s `LiveSessionPanel`
- **handleTabChange** s auto-createSession:
  ```typescript
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === "assistance" && selectedClient) {
      const existingSession = sessions?.find(s => s.clientId === selectedClient.id);
      if (!existingSession) {
        const sessionId = createSession(selectedClient.id, selectedClient.name);
        if (activePlan) updateSessionPlan(sessionId, activePlan);
      }
    }
  };
  ```
- `<Tabs value={activeTab} onValueChange={handleTabChange}>`
- onStartSession z ClientSessionPrepPanel → `setActiveTab("assistance")` + createSession + updateSessionPlan
- onEndSession → `fetchSessions()` + `setActiveTab("sessions")` + toast

## 2. `src/components/report/LiveSessionPanel.tsx` (~35 řádků)

- Nový state: `currentPhaseIndex` (useState(0))
- **Fázový banner** nad chatem (sessionMode === "plan"):
  - Název fáze, timeRange badge, "→ Další fáze" button
- Rozšířit `handleEndSession` body: přidat `sessionPlan` a `sessionMode`
- Přidat variantu bez plánu v mode selection dialogu (info text)

## 3. `supabase/functions/karel-session-finalize/index.ts` (~10 řádků)

- Rozšířit destructuring: `sessionPlan`, `sessionMode`
- Přidat `planContext` + `modeLabel` do system promptu

## Souhrn

| Soubor | Akce | ~Řádky |
|---|---|---|
| `Kartoteka.tsx` | UPRAVIT | ~20 |
| `LiveSessionPanel.tsx` | DOPLNIT | ~35 |
| `karel-session-finalize/index.ts` | DOPLNIT | ~10 |

Žádná DB migrace. Žádné nové závislosti.

