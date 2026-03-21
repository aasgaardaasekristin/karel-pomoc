

# Stav aplikace a další krok

## Co je hotovo (fáze 1-6 z 8)

1. Context Prime
2. Epizodická paměť
3. Registr částí + Live Session
4. Bootstrap paměti
5. Dashboard v2 (systémová mapa, úkoly, dohody, pulse check, kolegyně)
6. Koordinace terapeutů (handoffy, alerty, reflexe, auto-úkoly)

## Co zbývá: 2 fáze

**Fáze 7 — Detekce switchů** — už je částečně implementovaná (regex `[SWITCH:...]` v `Chat.tsx`, pravidla v daily cycle). Chybí: vizuální indikace switche v live session panelu, logování switchů do `did_part_sessions`, zobrazení switch historie na dashboardu.

**Fáze 8 — Supervizní reporty pro DID** — existuje obecný `karel-report`, ale chybí DID-specifický supervizní report, který agreguje data napříč částmi, sleduje vzorce switchů, zahrnuje reflexe terapeutek a generuje doporučení pro supervizi.

---

## Další logický krok: Zobrazení reflexe v plánu sezení

Než pokročím k fázím 7-8, je tu jeden malý ale důležitý gap: reflexe terapeutky se ukládá do `karel_notes`, ale **nezobrazuje se v rozbalení plánu sezení** v `DidDailySessionPlan`. Kolegyně ji tedy nevidí, pokud si neotevře raw data.

### Co se změní

V `src/components/did/DidDailySessionPlan.tsx`, v rozbalené sekci předchozího sezení (řádky 610-644):
- Parsovat `karel_notes` z `prevSession` na přítomnost sekce `## REFLEXE TERAPEUTKY`
- Pokud existuje, zobrazit ji jako nový blok pod AI analýzou s ikonou `PenLine` a stylem `bg-amber-500/5`
- Query pro `prevSession` rozšířit o `karel_notes`

### Soubor k úpravě

- `src/components/did/DidDailySessionPlan.tsx`

### Bez DB migrace

Data už existují v `karel_notes`, stačí je načíst a zobrazit.

