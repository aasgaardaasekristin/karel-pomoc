

# FÁZE 2 — Záložka „Připravit sezení" + předsezení briefing

5 souborů, ~355 řádků, 1 smazání, závislost: jspdf + html2canvas.

## 1. Smazat `src/components/report/SessionPlanPanel.tsx`

## 2. `src/pages/Kartoteka.tsx` (~15 řádků)

- Odstranit import `SessionPlanPanel` a tab `plan`
- Přejmenovat tab `prep` → `Připravit sezení`
- `sm:grid-cols-8` → `sm:grid-cols-7`
- Předat do `ClientSessionPrepPanel`: `sessions`, `onPlanApproved`, `onPlanDeleted`, `onStartSession`
- Předat do `CardAnalysisPanel`: `sessions`, `activePlan`, `pendingTasks`

## 3. `src/components/report/ClientSessionPrepPanel.tsx` (~300 řádků — kompletní přepis)

- **PrepState**: `idle` | `generating` | `review` | `approved`
- **idle**: Mód A (Karel sám) + Mód B (vlastní požadavek textarea)
- **generating**: progress indikátor (spinner + timed messages 0-4s/4-10s/10-20s/20s+)
- **review**: plan display (`id="session-plan-printable"`), phases cards (⏱ badge, technika, Řekni:, Všímej si:, Pomůcky:, Fallback:), `whyThisPlan` details, modification textarea, [🔄 Přepracovat] [📄 PDF] [✅ Schválit]
- **approved**: read-only plan + [📄 PDF] [▶ Zahájit asistenci] + 🗑️ delete
- **PDF**: jspdf + html2canvas from `#session-plan-printable`
- `originalRequestRef = useRef<any>(null)`

## 4. `supabase/functions/karel-session-plan/index.ts` — beze změn (ověřeno)

## 5. `src/components/report/CardAnalysisPanel.tsx` (~60 řádků)

### Nové props
```typescript
interface CardAnalysisPanelProps {
  clientId: string;
  clientName: string;
  sessions?: any[];
  activePlan?: any;
  pendingTasks?: any[];
  onRequestPlan?: (analysis: any) => void;
}
```

### Sekce PŘEHLED PŘED SEZENÍM (pod stávající analýzou, před tlačítka)

Sestaveno z existujících dat, žádné AI volání:

| Sekce | Zdroj |
|---|---|
| KDO JE KLIENT | `result.clientProfile` (první 2 věty) |
| SEZENÍ CELKEM + poslední datum | `sessionsCount` + `sessions?.[0]?.session_date` |
| **MINULÉ SEZENÍ – SHRNUTÍ** | `sessions?.[0]?.ai_analysis` — max 3 věty (`.split('.').slice(0,3).join('.')`) |
| DIAGNOSTICKÁ HYPOTÉZA | `result.diagnosticHypothesis.primary` + confidence badge |
| VHODNÉ TECHNIKY | `result.nextSessionRecommendations.suggestedTechniques` |
| CHYBĚJÍCÍ DATA | `result.dataGaps` |
| **OTEVŘENÉ ÚKOLY** | `pendingTasks?.filter(t => t.status !== 'done')` — 🔴 high / 🟡 medium / 🟢 low + 📝 client_homework |
| **PLÁN SEZENÍ** | `activePlan` ? `✅ Schválen [▶ Zahájit] [📋 Zobrazit]` : `⬜ Nevygenerován [📋 Sestavit plán]` |

## Závislosti

```bash
npm install jspdf html2canvas
```

## Souhrn

| Soubor | Akce | ~Řádky |
|---|---|---|
| `SessionPlanPanel.tsx` | SMAZAT | -170 |
| `Kartoteka.tsx` | UPRAVIT | ~15 |
| `ClientSessionPrepPanel.tsx` | PŘEPSAT | ~300 |
| `CardAnalysisPanel.tsx` | DOPLNIT | ~60 |

Žádná DB migrace.

