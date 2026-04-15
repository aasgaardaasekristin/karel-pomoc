

# Plán: Jung vizuál + Banner dedup + Sekce Dnes + Karlův přehled jako týmový dialog

## 1. Jung vizuál — skutečná oprava

**Příčina**: `.jung-study::before` a `::after` mají `position: fixed`, ale jsou uvnitř `<ScrollArea>` v `DidContentRouter.tsx` (řádek 363), který vytváří vlastní overflow context. Pseudo-elementy jsou oříznuté scroll kontejnerem.

**Řešení**: Přesunout vizuální vrstvu ven ze ScrollArea. V `DidContentRouter.tsx` pro `didFlowState === "terapeut"` obalit celý blok (ne jen ScrollArea obsah) do `jung-study` kontejneru:

```
<div className="jung-study flex-1 flex flex-col">
  <ScrollArea className="flex-1">
    <DidDashboard ... />
    ...
  </ScrollArea>
</div>
```

A z `DidDashboard.tsx` odstranit duplicitní `jung-study` class (řádek 400, 388). Dashboard bude renderovat jen `<div className="min-h-screen">` — vizuální vrstva přijde zvenku.

**Soubory**: `src/components/did/DidContentRouter.tsx` (řádky 361-424), `src/components/did/DidDashboard.tsx` (řádky 388, 400)

## 2. Banner — odstranění posledních duplicit

`mainBlocker` stále vrací "Doporučená porada nebyla otevřena" (řádek 365), zatímco banner row 1 už zobrazuje `meetingLabel: "⚠ porada doporučena"` (řádek 119).

**Řešení**: V `computeMainBlocker` přeskočit i poradní blokátor:
```typescript
// řádek 365: změnit podmínku
if (card.crisisMeetingRequired && !card.meetingOpen) return null; // už v badge
```

**Soubor**: `src/hooks/useCrisisOperationalState.ts` (řádek 365)

## 3. Sekce Dnes — odstranění starých plánů

`DidDailySessionPlan.tsx` řádek 101 query:
```
.or(`plan_date.eq.${today},and(status.eq.generated,plan_date.lt.${today})`)
```
Toto tahá staré Gustíky.

**Řešení**: Jen dnešní:
```
.eq('plan_date', today)
```

**Soubor**: `src/components/did/DidDailySessionPlan.tsx` (řádek 101)

## 4. Karlův přehled — přestavba na týmový dialog

Kompletní přepis `KarelDailyPlan.tsx`. Nová struktura:

**A. Oslovení obou terapeutek**: „Dobré ráno, Haničko a Káťo."

**B. 72h retrospektiva**: Souvislý narativ z `crisis_karel_interviews` + `did_threads` + `crisis_daily_assessments` za 3 dny. Ne „Komunikoval jsem s: ARTHUR" ale „Včera jsem vedl dlouhý rozhovor s Arthurem. Zdá se klidnější, ale jeho vnitřní nestabilita přetrvává..."

**C. Karlova rozhodnutí**: Z `karel_decision_after_interview` — „Rozhodl jsem se ponechat Arthura v režimu zvýšené pozornosti..."

**D. Návrh sezení**: Z `did_daily_session_plans` pro dnešek. Klikatelný odkaz → otevře konkrétní plán sezení (ne obecný chat).

**E. Úkoly s cílovými odkazy**: Každý úkol z `did_therapist_tasks` bude mít:
- Text úkolu
- Komu je určen (Hanička / Káťa / obě)
- Klikatelný odkaz podle typu:
  - „potvrdit zapojení" → otevře vlákno DID/Káťa s předpřipravenou otázkou
  - „naplánovat kroky" → otevře poradu s Karlovým návrhem
  - „koordinovat strategii" → otevře poradní vlákno

**F. Nezodpovězené otázky**: Z `did_pending_questions` — každá s přímým odkazem na odpovědní vlákno (DID/Hanička nebo DID/Káťa podle `directed_to`).

**G. Hodnocení spolupráce + motivace**: Krátký odstavec — „Vaše spolupráce včera byla výborná. Jen bych poprosil o včasnější odpovědi na mé otázky."

**H. Nabídka pomoci**: „Kdykoli se zaseknete, otevřete rozhovor se mnou." → klik otevře nové vlákno DID/Hanička s Karlem.

**I. Vstupní pole pro terapeutky**: Textarea kde mohou napsat Karlovi vzkaz (zachovat stávající logiku).

**Navigační model pro úkoly a otázky**:
- `directed_to` obsahuje "han" → navigate(`/chat?did_submode=mamka&task_id=${id}`)
- `directed_to` obsahuje "kát" → navigate(`/chat?did_submode=kata&task_id=${id}`)
- poradní typ → navigate s `didFlowState=meeting`
- plán sezení → navigate na DidDailySessionPlan s expandnutým plánem

**Soubor**: `src/components/did/KarelDailyPlan.tsx` (kompletní přepis)

## 5. Architektonická poznámka k sekcím

Stávající `DidDashboard` sekce „Dnes" obsahuje 3 vnořené komponenty: `DidDailySessionPlan`, `DidTherapistTaskBoard`, `PendingQuestionsPanel`. Tyto budou nadále existovat jako sekundární/backoffice pohled, ale hlavní denní přehled (úkoly, otázky, sezení) bude integrován přímo do Karlova přehledu s cílovými odkazy.

## Pořadí implementace

1. Jung vizuál (přesun `.jung-study` nad ScrollArea)
2. Banner dedup (porada)
3. Sekce Dnes (jen dnešní plány)
4. Karlův přehled (kompletní přepis)

## Akceptační podmínky

- Pergamenové pozadí + mandala + částice viditelné přes celou DID/Terapeut plochu
- Banner neobsahuje „porada doporučena" dvakrát
- V sekci Dnes žádné staré overdue plány
- Karlův přehled oslovuje Haničku i Káťu
- Každý úkol/otázka má klikatelný odkaz vedoucí na konkrétní workspace

