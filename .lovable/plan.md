Zjistil jsem hlavní příčiny. Nejde o jednu chybu, ale o nesoulad mezi tím, co Karlovy instrukce slibují, a tím, jak jsou živá sezení technicky zapojená.

## Co je teď špatně

1. Živé sezení volá Karla v režimu `supervision`, který má záměrně rychlou cestu bez těžkých operací. V kódu je výslovně uvedeno, že pro `supervision` a `live-session` se přeskakuje Drive, Perplexity/internet i úkoly. Proto když terapeut během sezení řekne „najdi na internetu Emma Tustin“, model nemá žádný nástroj, kterým by to v tom běhu provedl. Výsledkem je verbální „výmluva“ nebo přeformulování úkolu.

2. Ad-hoc internetová rešerše existuje mimo živé sezení (`karel-did-research`) a bloková metodická rešerše existuje pro plánované body (`karel-block-research`). Ale hlavní chat v živém sezení nemá automatický router, který by rozpoznal „vyhledej / najdi na internetu / ověř“ a zavolal rešeršní funkci.

3. Drive čtení existuje (`karel-did-drive-read`) a umí najít kartu části podle `partName`, ale živý chat si kartu během odpovědi dynamicky nenačítá. Dostává jen předem poslaný kontext (`contextBrief` / `didInitialContext`) a ten je oříznutý. Pokud se v průběhu sezení ukáže, že je potřeba karta nebo konkrétní dokument, Karel si ji neumí v tom samém kroku vyžádat a načíst.

4. Karel plánuje „pošlu obrázek do chatu“, ale v aplikaci není funkce, která by v živém sezení obrázek skutečně vygenerovala nebo vložila jako zprávu. Existuje upload a analýza obrázků od terapeutky, ne Karlovo odesílání obrázkových stimulů. Proto model slíbí klinicky smysluplný postup, ale technicky ho nemá jak splnit; potom začne couvat („obrázek není nutný“).

5. Některé instrukce v promptu jsou deklaratorní („máš přímý přístup k Drive“, „prostuduj kartu“), ale bez skutečného tool-call mechanismu. To je nebezpečné: model pak věří, že přístup má, ale reálně nedošlo k žádnému načtení. Potřebujeme z toho udělat explicitní pracovní protokol: pokud požadavek vyžaduje internet/Drive/obrázek, Karel nesmí odpovědět klinicky, dokud příslušná akce neproběhne nebo selhání není transparentně ukázané.

## Oprava: zavést „akční router“ pro živé sezení

Implementuji mezivrstvu před běžnou Karlovou odpovědí v `DidLiveSessionPanel` / backendu:

```text
Terapeutův vstup
   ↓
Live Action Router
   ├─ internet_search  → karel-did-research / nový stručný live-search endpoint
   ├─ drive_read       → karel-did-drive-read(partName/documents)
   ├─ image_stimulus   → nový endpoint pro vytvoření nebo výběr obrázkového stimulu
   └─ normal_reply     → běžná Karlova odpověď
   ↓
Karel odpoví až s reálným výsledkem akce v kontextu
```

## Konkrétní změny

### 1. Rozpoznávání přímých požadavků terapeuta
V živém sezení zachytím formulace typu:
- „najdi na internetu“, „vyhledej“, „ověř“, „kdo je Emma Tustin“
- „načti kartu“, „podívej se do karty“, „najdi na Drive“, „co je v dokumentu“
- „pošli obrázek“, „ukaž mu obrázek“, „dej obrázek věže/skvrny/dveří“

Tyto požadavky nepůjdou do obyčejného promptu jako text, ale spustí odpovídající backend akci.

### 2. Internet během sezení
Přidám live internet rešerši:
- dotaz typu „Emma Tustin“ se opravdu odešle do vyhledávání,
- výsledek se vloží do chatu jako Karlova odpověď s označením „nalezeno / zdroje / klinický význam pro asociaci“,
- následná odpověď Karla bude muset navázat na faktické výsledky, ne improvizovat.

Důležité: pro citlivá fakta bude Karel povinně oddělovat:
- co bylo nalezeno ve zdrojích,
- co Arthur řekl,
- jaká je klinická hypotéza,
- co nelze uzavřít.

### 3. Drive a karty částí během sezení
Napojím živé sezení na existující čtení Drive:
- když terapeut požádá o kartu části, zavolá se `karel-did-drive-read` s `partName`,
- výsledek se vloží do kontextu daného sezení,
- Karel odpoví až po načtení karty,
- pokud karta není nalezena, řekne konkrétní technické selhání, ne „výmluvu“.

Současně doplním auditní stopu do průběhu sezení: „načtena karta Arthur / dokument X / výsledek Y znaků“.

### 4. Obrázky/slíbené stimuly
Zavedu bezpečný mechanismus pro Karlovy obrázkové stimuly:

Varianta A — rychlá a stabilní:
- Karel neposílá generovaný obrázek, ale vybere předpřipravený stimul z interní sady: osamělá věž, tři dveře, cesta lesem, dům v krajině, abstraktní skvrna apod.
- UI vloží do chatu vizuální kartu stimulu.

Varianta B — plnohodnotná:
- backend vygeneruje obrázek přes podporovaný obrazový model,
- uloží ho do úložiště,
- vloží do chatu jako obrázkovou zprávu.

Navrhnu začít variantou A, protože je levnější, rychlejší, reprodukovatelná a klinicky bezpečnější. Karel už pak nesmí říct „pošlu obrázek“, pokud obrazový stimul skutečně nevloží do chatu.

### 5. Zákaz falešných slibů v promptu
Upravím prompt pro živé sezení:
- Karel nesmí tvrdit, že něco vyhledal, načetl nebo poslal, pokud akce neproběhla.
- Pokud požadavek vyžaduje nástroj, musí odpověď začít provedením nástroje nebo transparentním selháním.
- „Obrázek není nutný“ nesmí být použito jako únik, pokud sám Karel obrázek naplánoval nebo ho terapeut výslovně vyžádal.

### 6. Persistování do záznamu sezení
Všechny tyto akce se propíšou do `did_live_session_progress` / vyhodnocení sezení:
- internetová rešerše včetně dotazu a zdrojů,
- Drive čtení včetně názvu dokumentu,
- vložený obrázkový stimul,
- klinická návaznost na výsledek.

Tím se další ranní přehled a následné vyhodnocení nebudou tvářit, že se nic nestalo.

## Technická místa zásahu

- `src/components/did/DidLiveSessionPanel.tsx` — zachytit přímé požadavky terapeuta a místo běžného chatu spustit action router.
- `supabase/functions/karel-chat/index.ts` — opravit režim živého DID sezení, aby nepoužíval `supervision` fast-path bez Drive/internetu, nebo mu přidat výslovné action pre-processing.
- `supabase/functions/karel-did-research/index.ts` — doplnit stručný live režim pro konkrétní faktografické dotazy typu „Emma Tustin“.
- `supabase/functions/karel-did-drive-read/index.ts` — použít existující `partName` režim přímo z live sezení.
- Nově: `supabase/functions/karel-live-stimulus-image` nebo interní knihovna stimulů — vložení obrázku/stimulu do chatu.
- `supabase/functions/karel-did-session-evaluate/index.ts` — zahrnout action logy do vyhodnocení.

## Jak ověřím opravu

Otestuji tři scénáře:

1. Terapeut napíše: „Najdi prosím na internetu Emma Tustin a vysvětli souvislost s Arthurovou asociací.“
   - očekávání: proběhne skutečné vyhledání, odpověď obsahuje zdroje a klinickou interpretaci.

2. Terapeut napíše: „Načti si Arthurovu kartu a zohledni ji.“
   - očekávání: aplikace zavolá Drive čtení, Karel řekne, co z karty použil.

3. Terapeut napíše: „Pošli obrázek osamělé věže, jak jsi slíbil.“
   - očekávání: do chatu se vloží obrázkový stimul nebo vizuální karta; Karel nepřehodí odpověď na „není nutné“.

Výsledkem bude, že Karel nebude jen „mluvit o přístupu“ k internetu/Drive/obrázkům, ale bude mít skutečný vykonávací mechanismus a auditní stopu.