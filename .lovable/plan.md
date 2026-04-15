<final-text>
Stav: NENÍ OK.

Co jsem ověřil:
- Prošel jsem DOK1, DOK2, GAP audit, audit dashboardu, governance prompt i aktuální kód.
- Udělal jsem i externí rešerši: kvalitní DID/terapeutický cockpit musí mít 1) jasnou bezpečnostní vrstvu, 2) průběžné longitudinální hodnocení, 3) mezioborovou koordinaci, 4) uzavíratelný cyklus „zadání → odpověď → vyhodnocení → další krok“, 5) individualizaci podle konkrétní části, ne generický dump.
- Aktuální implementace to nesplňuje.

Co je teď konkrétně špatně:
1. Dvojité funkce:
   - `chybí interview` i `Spustit dnešní hodnocení` dnes vedou na stejnou akci `start_interview`.
   - `chybí feedback` i `Získat feedback terapeutek` dnes fakticky nevedou do samostatného workflow.
2. Banner není route-aware:
   - `CrisisAlert.tsx` neumí otevřít DID/Kluci krizové vlákno ani feedback workspace.
   - většina CTA jen rozbalí `CrisisOperationalDetail`.
3. Semantika je rozbitá:
   - `Vyžádat update` dnes volá `karel-crisis-daily-assessment`, což není „update od terapeutky“, ale denní assessment.
4. Dashboard není jedno operační centrum:
   - `DidDashboard.tsx` má useknutou strukturu,
   - `DidContentRouter.tsx` pod ním dál renderuje tmavé černé bloky s inline styly,
   - tím se zabíjí Jungova pracovna i informační logika.
5. Feedback vrstva je zakopaná:
   - `PendingQuestionsPanel` je generický inbox,
   - `CrisisTherapistFeedback` je schované uvnitř timeline,
   - není to samostatné pracoviště pro Haničku/Káťu.
6. Duplicitní texty:
   - `computeMainBlocker()` generuje „79h bez kontaktu…“
   - `CrisisAlert.tsx` to ještě vypisuje zvlášť jako plain text.

Co bych udělal jinak:
Nevázal bych banner na accordion detail. Banner musí být operační rozcestník, ne roletka.
Zavedl bych 4 odlišné akce s odlišným výsledkem:

1. `chybí interview`
- jen navigační stavový odkaz
- otevře/resumuje krizové DID/Kluci vlákno pro konkrétní část
- bez nového zápisu, pokud dnešní vlákno už existuje

2. `Spustit dnešní hodnocení`
- aktivní orchestrace
- založí/obnoví dnešní `crisis_daily_assessment`
- připraví Karlův krizový rozhovor
- potom otevře stejné krizové vlákno

3. `chybí feedback`
- jen navigační stavový odkaz
- otevře feedback workspace na první nezodpovězenou otázku

4. `Získat feedback terapeutek`
- aktivní orchestrace
- vygeneruje/obnoví sadu otázek pro Haničku a Káťu
- potom otevře feedback workspace

Tím přestane double-funkce a každé tlačítko bude mít jiný smysl.

Nový návrh DID/Terapeut dashboardu:
```text
[ Tichá operační hlavička ]
  poslední validní briefing | live sync | recovery | čeká se na odpověď

[ Krizový banner ]
  část | stav | den | bez kontaktu s částí | bez kontaktu terapeutů
  stavové odkazy: chybí interview | chybí feedback | porada
  akce: Spustit dnešní hodnocení | Získat feedback terapeutek | Otevřít krizovou poradu

[ Karlův denní plán / 05A ]
  urgentní | sezení dnes | úkoly pro Haničku | úkoly pro Káťu | otevřené otázky

[ Dnešní operační centrum ]
  A. Kdo mluví s Karlem / kdo chybí
  B. Sezení dnes
  C. Úkoly týmu
  D. Čeká na odpověď / feedback / blokace

[ Sekundární zóna ]
  dohody | týdenní trendy | mapa systému | supervize
```

Co konkrétně opravím:
1. `src/components/karel/CrisisAlert.tsx`
- oddělím stavové odkazy od akčních tlačítek
- odstraním duplicitní texty o hodinách bez kontaktu
- odstraním horní terapeutický štítek typu „Hanička“, pokud není součástí skutečné akce
- klik na `chybí interview` a `chybí feedback` už nebude rozbalovat detail, ale route/deep-link
- CTA budou mít jasný loading, success, error a viditelný výsledek

2. `src/hooks/useCrisisOperationalState.ts`
- přestanu generovat blocker text, který duplikuje plain-text kontakt
- upravím CTA logiku tak, aby nevytvářela dvojice se stejným významem
- `request_update` přestane být přejmenovaný assessment

3. `src/pages/Chat.tsx` + `src/components/did/DidContentRouter.tsx`
- přidám skutečné deep-linky pro krizové workflow:
  - otevření krizového DID/Kluci vlákna
  - otevření feedback workspace
  - otevření krizové porady
- banner už nebude slepý vůči routingu
- celý terapeutický workspace přesunu do jedné vizuální shell vrstvy, aby nezůstávaly černé inline karty pod dashboardem

4. `src/hooks/useDidThreads.ts`
- doplním krizový typ vlákna/resume logiku
- při krizovém vstupu se bude hledat dnešní krizové vlákno pro `crisis_event_id`, ne jen obyčejné vlákno podle part name
- když neexistuje, vytvoří se nové s názvem typu:
  `Rozhovor s Arthurem — krizové sezení`

5. nový krizový vstup do DID/Kluci
- Karel nepřijde do prázdného vlákna
- vlákno dostane připravené úvodní oslovení podle stavu části a krizového kontextu
- tohle nebude frontend hack; bootstrap udělá backend, aby úvod vycházel z reálných dat

6. feedback workflow
- `PendingQuestionsPanel` rozdělím na samostatný krizový workspace:
  - Hanička zvlášť
  - Káťa zvlášť
  - každá uvidí své otázky, blokace, termín, odpovědi
- `CrisisTherapistFeedback.tsx` přestane být schovaná timeline vložka
- feedback bude mít jasné sekce:
  - co Karel potřebuje vědět
  - proč to potřebuje
  - odpověď textem / checkboxy / škála podle typu otázky
  - odeslat Karlovi

7. `src/components/did/DidDashboard.tsx`
- obnovím dashboard jako jednotnou pracovní místnost
- vrátím smysluplné sekce „Kdo mluví s Karlem / kdo chybí“, „Čeká se na odpověď“, „Úkoly“ a „Sezení“ tak, aby nebyly duplicitní a byly route-aware
- krizový detail nebude hlavní reakce na klik z banneru

8. `src/components/did/KarelDailyPlan.tsx`
- nechám 05A jako hlavní pravdu dne
- ale napojím ho na akce a lifecycle, ne jen na textový výpis
- opravím i současný React warning kolem `PlanBlock`

9. `src/index.css` + terapeut shell
- Jungovu pracovnu neváže jen na vnitřek dashboardu, ale na celý DID/Terapeut workspace
- odstraním černé inline styly v routeru
- vizuální vrstva bude skutečně vidět: pergamen, teplé světlo, mandala watermark, jemné zlaté částice, ale bez rušivosti

Nutné backend změny:
1. Nový malý backend krok pro bootstrap krizového vlákna
- doporučuji nový izolovaný endpoint, ne lepit to celé do `karel-crisis-interview`
- výstup:
  - `interview_id`
  - `thread_label`
  - `initial_assistant_message`
  - `resume_thread_id` pokud už existuje

2. Rozšíření `karel-crisis-daily-assessment`
- ať umí explicitně:
  - založit dnešní assessment shell
  - vygenerovat otázky pro terapeutky
  - vrátit, co přesně vytvořil

3. Rozšíření dat pro otázky
- stávající `did_pending_questions` nestačí pro checkboxy a strukturované odpovědi
- doplnil bych metadata typu:
  - `response_mode`
  - `response_options`
  - `answer_json`
  - `group_key`
- tím půjde udělat Hanička/Káťa formulář profesionálně, ne stringovým hackem

4. Volitelně rozšířit `did_threads`
- přidat vazbu na `crisis_event_id` / `thread_kind='crisis_interview'`
- tím půjde krizové vlákno spolehlivě znovu otevřít

Implementace po malých krocích:
Fáze A — krizový banner a routing
- opravit význam všech 4 akcí
- zavést skutečné deep-linky
- odstranit duplicity a mrtvá CTA

Fáze B — krizové DID/Kluci vlákno
- bootstrap krizového vlákna
- automatický název
- připravený Karlův úvod
- resume logika

Fáze C — feedback workspace
- samostatný panel pro Haničku/Káťu
- generace otázek
- text/checkbox/škála
- odeslání a návrat do krizového cyklu

Fáze D — přestavba dashboardu
- jednotná Jungova pracovna
- návrat operačních sekcí
- odstranění černých bloků a inline stylů
- zviditelnění opravdu živé vizuální vrstvy

Fáze E — lifecycle
- propojit: hodnocení → rozhovor → feedback → další krok → uzavření / eskalace
- aby nic neviselo bez vlastníka a bez výsledku

Co bude výsledek po opravě:
- klik na `chybí interview` opravdu otevře DID/Kluci krizové vlákno s Karlem
- klik na `Spustit dnešní hodnocení` nejdřív vytvoří dnešní klinický záznam a pak tě tam dovede
- klik na `chybí feedback` opravdu otevře feedback formulář
- klik na `Získat feedback terapeutek` opravdu připraví otázky a otevře workspace
- banner přestane mít duplicitní texty
- dashboard přestane být směs tmavých karet a nehotových sekcí
- DID/Terapeut se stane živým ústředním střediskem pro Haničku, Káťu a Karla

Akceptační podmínky:
1. Arthur v banneru:
   - `chybí interview` otevře krizové vlákno, ne roletku
2. `Spustit dnešní hodnocení`:
   - vytvoří dnešní assessment a je vidět, co vzniklo
3. `chybí feedback`:
   - otevře první nezodpovězený feedback formulář
4. `Získat feedback terapeutek`:
   - po kliknutí vzniknou/obnoví se otázky pro obě terapeutky
5. žádné dvojité „79 h bez kontaktu“
6. žádné mrtvé CTA
7. Jungova pracovna je vidět na celé DID/Terapeut ploše, ne jen uvnitř jedné karty

Nejmenší další krok k implementaci:
1. nejdřív přepíšu semantiku banneru a routing krizových akcí
2. potom zavedu bootstrap krizového vlákna a feedback workspace
3. teprve potom přestavím celý dashboard shell a vizuál
</final-text>