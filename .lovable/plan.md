<final-text>
Stav: vaše výtka je oprávněná.

Proč to teď působí jako ignorování:
- Udělal jsem jen povrchový textový facelift Karlova přehledu, ale nepřebudoval architekturu.
- V `KarelDailyPlan.tsx` generuji odkazy přes `task_id`, `question_id`, `session_part` a `didFlowState=meeting&meeting_topic=...`, ale `Chat.tsx` dnes z URL skutečně obsluhuje jen `crisis_action` a `meeting=<id>`. Proto jsou CTA mrtvá.
- `DidDashboard.tsx` stále současně renderuje `DidDailySessionPlan`, `DidTherapistTaskBoard` a `PendingQuestionsPanel`, takže zůstává dublování, které jste už dříve výslovně odmítla.
- Jungův shell je technicky jen na vnitřní části DID/Terapeut a personalizace z „Vzhled“ ho může přebít; proto není zřetelný jako základ celé plochy.
- Karlův přehled padá do generického fallbacku: z 05A tahá krátký kus textu a 72h část skládá z krátkých vět. Proto vzniká nepřijatelně chudý text typu „Komunikoval jsem s: ARTHUR.“

Co je podle vás správně a s čím souhlasím:
- Karlův přehled nemá být dump ani „monologická dekorace“, ale vedený týmový dialog Karla s Haničkou a Káťou.
- DID/Terapeut musí být rozdělen na společné prostory a soukromé dialogy.
- Každý bod musí vést na konkrétní funkční workspace.
- Hlavní plocha smí ukazovat jen dnešní a validní realitu.

Návrh nové architektury
```text
DID / Terapeut
├─ Společné prostory
│  ├─ Karlův briefing-dialog
│  ├─ Porady týmu
│  └─ Dnešní operativa (jen dnešní validní věci)
├─ Soukromé dialogy
│  ├─ Karel ↔ Hanička
│  └─ Karel ↔ Káťa
└─ Akční workspaces
   ├─ potvrzení účasti
   ├─ odpověď na Karlovy otázky
   ├─ návrh / konzultace sezení
   └─ společná porada nad konkrétním tématem
```

Co konkrétně přepíšu:
1. Routing a dead-link vrstvu
- `src/pages/Chat.tsx`: doplním centrální DID deep-link parser pro:
  - `task_id`
  - `question_id`
  - `session_part`
  - `didFlowState=meeting&meeting_topic=...`
  - `did_submode=...`
- `src/components/did/KarelDailyPlan.tsx`: všechny akce budu generovat jen přes kontrakt, který `Chat.tsx` opravdu umí.
- `src/components/did/DidMeetingPanel.tsx`: při `meeting_topic` otevře buď existující poradu, nebo vytvoří novou s předvyplněným tématem a Karlovým zadáním.

2. Přestavbu Karlova přehledu na vedený dialog
- Úvod nebude jedna věta, ale víc odstavců v této osnově:
  1) oslovení obou terapeutek
  2) co je nové za 24h
  3) co plyne z posledních 72h
  4) co Karel rozhodl
  5) co dnes navrhuje
  6) co konkrétně chce od Haničky / Káti / obou
  7) hodnocení posledního sezení nebo důvod, proč chybí
  8) Karlova nabídka pomoci
- `src/components/did/KarelDailyPlan.tsx`: odstraním generické věty typu „Komunikoval jsem s…“ a nahradím je souvislým briefingem z 05A + 72h dat + dnešních úkolů + otázek.
- Každý úkol dostane konkrétní akční text, adresáta, účel a funkční cíl.

3. Rozdělení na společné a soukromé prostory
- Společný prostor:
  - briefing
  - společné porady
  - společné body dne
- Soukromé prostory:
  - Hanička: její Karlovy otázky, její úkoly, její odpovědní vlákna
  - Káťa: totéž odděleně
- Navigace:
  - úkol pro Káťu -> DID/Káťa + konkrétní workspace
  - otázka pro Haničku -> DID/Hanička + konkrétní formulář
  - společný bod -> Porada týmu + konkrétní téma + Karlův návrh

4. Odstranění duplicit z hlavní plochy
- `src/components/did/DidDashboard.tsx`: z hlavní plochy odstraním paralelní bloky `DidTherapistTaskBoard` a `PendingQuestionsPanel`; zůstanou jen jako sekundární/backoffice pohled, ne jako druhý dashboard pod briefingem.
- `src/components/did/DidDailySessionPlan.tsx`: v bloku „Dnes“ ponechám jen dnešní validní sezení/plán, bez starých overdue položek a bez historických krizových zbytků.
- `src/hooks/useCrisisOperationalState.ts` + `src/components/karel/CrisisAlert.tsx`: dokončím semantické odduplicitnění banneru.

5. Jungovu pracovnu jako skutečný baseline shell
- `src/pages/Chat.tsx` + `src/components/did/DidContentRouter.tsx` + `src/index.css`:
  - přesunu Jung shell o úroveň výš, aby pokryl i header/chrome, ne jen vnitřní obsah
  - personalizace z „Vzhled“ bude až nadstavba, ne automatický přepis základu
- `src/components/ThemeEditorDialog.tsx`: přidám logiku „Použít osobní variantu / Vrátit základní shell“
- Vizuální pravidlo zůstává: jemný pergamen, psychologicky klidný efekt, bez křiklavých barev.

Nutné datové doplnění:
- Dnešní model úkolů a otázek neumí určit cílový workspace. Proto doplním metadata:
  - u `did_therapist_tasks`: `action_type`, `workspace_scope`, `workspace_slug`, `workspace_payload`
  - u `did_pending_questions`: `response_mode`, `workspace_slug`, `form_payload`
  - u `did_meetings`: vazbu na zdrojový úkol / otázku
- Bez toho budou odkazy dál jen generické nebo polofunkční.

Změna mého pracovního postupu:
- Už nebudu považovat textový přepis za splnění architektury.
- Už nevystavím CTA, dokud neexistuje celá cesta:
  `zdroj v UI -> query/route -> parser -> workspace -> cílový stav`.
- Už nenechám na hlavní ploše žít staré paralelní sekce, pokud mají být pohlceny briefingem.
- Už nebudu používat generické názvy úkolů bez explicitní otázky, cíle a adresáta.
- Před předáním budu validovat 5 podmínek:
  1) vizuál je skutečně vidět
  2) žádná duplicita
  3) žádný mrtvý odkaz
  4) žádná stará data v „Dnes“
  5) briefing je dialogický, adresný a akční

Pořadí implementace:
1. routing/deep-link kontrakt
2. odstranění duplicit v `DidDashboard`
3. přepis Karlova briefingu
4. task/question/meeting workspace model
5. baseline Jung shell + override logika

Akceptace:
- klik na „Odpovědět / řešit“ otevře konkrétní pracovní místo, ne mrtvý parametr
- klik na „Otevřít poradu“ otevře konkrétní poradu k tématu, ne nefunkční route
- Karlův přehled mluví k Haničce i Kátě ve více odstavcích a skutečně řídí práci
- sekce „Dnes“ už není paralelní druhý dashboard
- Jungova pracovna je zřetelně vidět přes celý DID/Terapeut workspace
</final-text>