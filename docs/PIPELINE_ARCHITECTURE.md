# Karel DID – Pipeline Architektura

## Přehled

Karel používá 5-vrstvou pipeline pro zpracování informací z terapeutických sezení.

```
[Zdroje]                    [Mezivrstva]              [Výstupy]
                            
Vlákna (cast/mamka/kata) ──→ did_observations ──→ did_implications ──→ did_plan_items (05A/05B)
Task feedback ─────────────→                  └──→ did_profile_claims ──→ Karty částí (Drive)
Sezení (session finalize) ─→                  └──→ did_pending_questions
Krizový scan ──────────────→
```

## Fáze

| Fáze | Co řeší | Klíčové funkce |
|------|---------|---------------|
| 1 | Tabulky + shared helpery | `_shared/observations.ts`, `_shared/implications.ts` |
| 2 | Sync 05A/05B na Drive | `post-intervention-sync` |
| 3 | Karty částí (stav vs. rys) | `update-part-profile` |
| 4 | Observation zdroje + weekly review | `karel-did-daily-cycle`, `karel-task-feedback`, `karel-session-finalize`, `karel-weekly-review` |
| 5 | End-to-end integrace | `karel-daily-refresh` (pipeline context), `karel-chat` (rendering) |

## Tabulky

| Tabulka | Role |
|---------|------|
| `did_observations` | Surová fakta (D1-D3, I1, H1) s time_horizon a status |
| `did_implications` | Odvozené dopady s impact_type a destinations[] |
| `did_plan_items` | Položky pro 05A (operativní) / 05B (strategický) |
| `did_profile_claims` | Profilová tvrzení (current_state, stable_trait, hypothesis, risk) |
| `did_pending_questions` | Otevřené otázky čekající na evidenci |
| `did_doc_sync_log` | Log zápisů na Drive |

## Evidence Levels

| Level | Význam | Confidence |
|-------|--------|-----------|
| D1 | Přímý výrok části | 0.9 |
| D2 | Pozorování terapeutky | 0.7 |
| D3 | Objektivní událost | 0.8 |
| I1 | Karlova inference | 0.5 |
| H1 | Hypotéza | 0.3 |

## Routing pravidla

| Kategorie + Time Horizon | Směr |
|--------------------------|------|
| risk_signal (jakýkoli) | immediate_plan → 05A |
| logistics + hours | immediate_plan → 05A |
| logistics | plan_05A |
| hours | immediate_plan |
| 0_14d | plan_05A |
| 15_60d | plan_05B |

## Claim Lifecycle

```
Nový claim → hypothesis (1× potvrzení)
  → 2× potvrzení z různých zdrojů → hypothesis (silnější)
  → 3× potvrzení → stable_trait (POTVRZENÝ RYS)
  
current_state → zapisuje se IHNED (není třeba potvrzení)
risk → zapisuje se IHNED
trigger → zapisuje se IHNED
```

## Cron Schedule

| Job | Schedule | Funkce |
|-----|----------|--------|
| Denní cyklus | `0 5 * * *` (5:00 UTC) | `karel-did-daily-cycle` |
| Weekly review | `0 20 * * 0` (neděle 20:00 UTC) | `karel-weekly-review` |
| Kartotéka update | `0 */6 * * *` (každých 6h) | `karel-kartoteka-cron` |

## Rate Limits

- Max 20 vláken zpracovaných za jeden denní cyklus
- Max 100 observations za den
- 12h cooldown per vlákno
- Max 10 claims na jedno volání update-part-profile
- Max 1 změna stable_trait per part per 7 dní

## Pipeline Health Check

Denní cyklus loguje na konci:
```
[daily-cycle] Pipeline health: obs=X, claims=Y, plans=Z, questions=W, recent48h=N
```
Pokud `recent48h=0` → varování že pipeline může být zastavená.
