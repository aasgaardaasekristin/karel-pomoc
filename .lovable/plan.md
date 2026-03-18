

## Diagnóza: Přesná příčina nekonečné smyčky na "centrum"

**Co se děje:** Logy jednoznačně ukazují tento vzorec (opakuje se donekonečna):
```text
boot → "gathering centrum..." → "Centrum done" → shutdown → boot → "gathering centrum..." → ...
```

**Přesná příčina:** Funkce `gatherCentrum` čte soubory z Drive (dohody, mapu, instrukce). To trvá sekundy. Po dokončení se pokusí zapsat do DB aktualizovaný `context_data` (28 KB JSONB) se změnou `gather_step: "db"`. Ale runtime se **vypne (shutdown) dřív, než se zápis do DB dokončí**. Následující volání tedy znovu přečte `gather_step: "centrum"` a celý krok se opakuje.

Navíc frontend posílá paralelní requesty (logy ukazují dvojité booty v rozmezí 250 ms), což vytváří race condition — dva requesty čtou stejný stav a přepisují si navzájem výsledky.

**Proč resumable architektura selhává:** Ukládání 28 KB textu do `context_data` po každém kroku je pomalé a křehké. Jeden shutdown zmaří celý zápis a krok se nikdy neposune.

## Řešení: Zjednodušení architektury

Resumable gather architektura je přeinženýrovaná a způsobuje více problémů, než řeší. Edge funkce má 150s limit; skutečný gather trvá ~60-90s.

### 1. Backend: Spojit gather do jednoho volání
- **Zrušit** resumable sub-kroky (init → cards_active → cards_archive → centrum → db → perplexity)
- **Jedna funkce** `phaseGather` přečte vše v jednom requestu s přísným time-budgetem
- Přesunout velký textový obsah **pouze do paměti** (RAM), ne do `context_data`
- `context_data` bude obsahovat jen malá metadata (seznam jmen karet, datum)
- Perplexity se volá jen pokud zbývá >30s, jinak se přeskočí
- Heartbeat se zapisuje průběžně (malé updaty, jen timestamp + detail)
- Po dokončení: jeden zápis do DB s `phase: "gathered"` + malá context_data
- Při selhání: explicitní `try/catch` s `phase: "failed"`

### 2. Backend: Ochrana proti race condition
- Na začátku `phaseGather` zkontrolovat, zda cyklus je stále `running` a `phase === "gathering"` nebo `phase === "created"`
- Pokud ne, okamžitě vrátit bez akce
- Frontend nebude posílat paralelní requesty (viz bod 3)

### 3. Frontend: Sériové volání bez paralelismu  
- `continueCycle` bude striktně sériové — žádné `while(needsMore)` smyčky
- Zrušit auto-advance `useEffect` který reaguje na polling data (to způsobuje duplicitní volání)
- Jednoduchý flow: kickoff → gather → analyze → distribute → notify, vždy čekat na odpověď před dalším voláním
- Polling jen pro zobrazení progresu, **nikdy** pro spouštění dalších fází

### 4. Vyčistit zaseklý cyklus
- SQL update: označit aktuální zaseklý cyklus jako `failed`

### Soubory k úpravě:
- `supabase/functions/karel-did-weekly-cycle/index.ts` — zjednodušit gather na jeden blok
- `src/components/did/DidAgreementsPanel.tsx` — sériové volání, zrušit auto-advance effect
- SQL: vyčistit zaseklý záznam

