Beru tvoji korekci jako závazné zpřesnění předchozího návrhu. Původní plán byl dobrý jako směr, ale musí být utažen tak, aby vývoj neskončil jen u „lepší Herny jako chatu“. Níže je doplněná implementační specifikace.

## Cíl

Vybudovat klinicko-organizační workflow pro dvě odlišné situace:

1. **Herna**: Karel vede přímo dítě/část podle schváleného programu.
2. **Sezení**: fyzicky vede terapeutka, Karel je live real-time asistent terapeutky.

Oba režimy musí mít:

- tvrdé schválení programu před spuštěním,
- bezpečný runtime kontrakt,
- krizovou/safety vrstvu,
- ukončovací nebo noční vyhodnocení,
- detailní analýzu `(1)`,
- praktický report `(2)`,
- DB auditní záznam,
- povinný Drive výstup,
- povinný zápis do `kartoteka_DID` / karty konkrétní části,
- zobrazení v následujícím `Karlův přehled`.

## Základní architektonické pravidlo

DB může být operační runtime/cache/index pro rychlé čtení dashboardu, ale **Drive a kartoteka_DID nesmí být jen volitelná dokumentační kopie**.

Každý report z Herny i Sezení musí mít povinně:

- DB záznam,
- Drive dokument nebo Drive link pro detailní analýzu `(1)`,
- Drive dokument nebo Drive link pro praktický report `(2)`,
- zápis do karty konkrétní části v `kartoteka_DID`,
- stav synchronizace s Drive:
  - `sync_status`,
  - `synced_to_drive`,
  - `drive_detail_analysis_id`,
  - `drive_practical_report_id`,
  - `card_write_status`,
  - `last_sync_error`,
  - `synced_at`.

Ranní briefing smí číst z DB kvůli rychlosti, ale musí rozlišit, zda daný report už má potvrzenou Drive/karta synchronizaci, nebo je ještě ve stavu čekající synchronizace.

## 1. Stabilizace `karel-chat` a Herna runtime

### Oprava backend pádu

V `karel-chat` opravit chybějící Jung importy a ponechat guard, aby Jung originální injekce neběžela pro dětský/Herna režim.

### `PLAYROOM_SYSTEM_CONTRACT`

Přidat samostatný kontrakt pro Herna režim:

- Herna není běžné DID/Kluci vlákno.
- Karel pracuje podle aktuálně schváleného programu.
- Vždy reaguje na poslední vstup dítěte.
- Odpověď má mít krátkou strukturu:
  1. naladění na poslední vstup,
  2. mikro-motivace,
  3. jeden konkrétní krok/test/hra/volba A/B,
  4. bezpečné zakončení.
- Karel nesmí sám od sebe spouštět běžné „pošli mamince vzkaz“ chování, pokud dítě samo nepožádá nebo nejde o bezpečnostní/safety eskalaci.

### Multimodální vstup

Před AI voláním vytvořit explicitní blok:

```text
POSLEDNÍ VSTUP DÍTĚTE
text: ...
přílohy: ...
typ: image/screenshot/audio/video/document
co je reálně analyzováno: ...
co není možné tvrdit bez přepisu/analýzy: ...
```

Post-chat extrakce musí umět číst i multimodální pole, ne jen string `content`.

### Dětsky bezpečný fallback

UI nikdy nesmí ukázat prázdnou odpověď, technický JSON ani tvrdou chybu. Při selhání zobrazí klidný text:

```text
Karel tě slyší, jen se mu teď technicky zasekla odpověď. Zkusíme to ještě jednou.
```

Současně zachová vstup dítěte a nabídne `Zkusit znovu`.

Interní stavy UI:

- `Karel poslouchá`,
- `Karel přemýšlí`,
- `Karel je technicky přetížený`,
- `Zkusit znovu`.

## 2. Samostatný kontrakt pro terapeutem vedené Sezení

Vedle `PLAYROOM_SYSTEM_CONTRACT` přidat:

```text
THERAPIST_SESSION_ASSISTANT_CONTRACT
```

Pravidla:

- Karel v tomto režimu nevede dítě přímo.
- Karel vede terapeutku krok za krokem.
- Po každém zápisu terapeutky nabídne:
  - další mikro-krok,
  - přesnou terapeutickou formulaci, co lze říct,
  - jednu/dvě otázky, které má terapeutka položit,
  - čeho si má všímat,
  - co má zaznamenat pro pozdější kvalitativní analýzu,
  - kdy zpomalit nebo stabilizovat,
  - kdy nepokračovat a aktivovat safety režim.
- Výstup musí pomáhat kvalitě pozdější analýzy, ne jen „chatovat“.

## 3. Tvrdé schvalovací workflow programu

Program Herny i Sezení musí mít explicitní stavy:

```text
draft
awaiting_therapist_review
in_revision
approved
ready_to_start
in_progress
completed
evaluated
archived
```

Pravidlo blokování:

- `Vstoupit do herny` a `Spustit sezení` nesmí být aktivní, dokud plán není `approved` nebo `ready_to_start`.
- Pokud se program upraví terapeutkami, vrací se do `in_revision` a znovu čeká na schválení.
- Schválený program je autoritativní runtime zdroj pro Hernu/Sezení.

## 4. Pre-flight runtime packet

Před vstupem do Herny i Sezení se připraví runtime packet těžkým modelem.

Obsah:

- schválený program,
- cíle dne,
- hlavní téma,
- očekávané reakce části,
- stop signály,
- safety guardy,
- doporučené reakce,
- mikro-testy / hry / otázky,
- zakázané směry,
- verze kontraktu,
- model použitý pro přípravu.

Živé turny pak nemusí znovu vytvářet celý klinický rámec od nuly.

## 5. Ukončení a noční safety-net

### Herna

Tlačítko `Ukončit hernu` musí spustit stejný typ ukončovacího procesu jako `Ukončit a analyzovat` u Sezení:

1. detailní profesionální analýza `(1)` těžkým modelem,
2. praktický report `(2)`,
3. zápis do DB,
4. zápis do Drive,
5. zápis do karty části,
6. vstup pro následující `Karlův přehled`.

### Sezení

Tlačítko `Ukončit a analyzovat` zůstává hlavní cestou, ale nesmí být jedinou cestou.

### Částečná/neukončená sezení

Denní/noční safety-net musí vyhodnotit i situace, kdy:

- nebylo stisknuto ukončení,
- existují chatové záznamy,
- existují terapeutické poznámky,
- proběhla část checklistu/programu,
- existuje změna stavu programu.

Výstup musí být označen jako částečný/evidence-limited, ne fingovat dokončené sezení.

## 6. Scheduler kolem 03:00 Europe/Prague

Přidat nebo zpřesnit scheduled job:

```text
03:00 Europe/Prague – daily session/playroom consolidation
```

Každý den zpracuje předchozí den:

1. uzavřené Herny,
2. neuzavřené, ale aktivní Herny,
3. uzavřená Sezení,
4. neukončená, ale částečně proběhlá Sezení,
5. chybějící analýzy,
6. Drive synchronizaci,
7. zápis do karet částí,
8. přípravu vstupů pro `Karlův přehled`.

Při selhání:

- uložit `last_sync_error`,
- neoznačit jako hotové,
- umožnit retry,
- nezablokovat celý ranní briefing; briefing zobrazí stav „čeká na synchronizaci“.

## 7. Přesné reportové šablony

Každý report musí mít strukturovaná pole:

```text
part_name
date
mode: playroom | therapist_session
lead_person: Karel | Hanička | Káťa | společně
assistant_persons
approved_program_id
program_title
main_topic
completion_status
clinical_findings
implications_for_part
implications_for_whole_system
recommendations_for_therapists
recommendations_for_next_session
recommendations_for_next_playroom
detailed_analysis_text
practical_report_text
drive_detail_analysis_id
drive_practical_report_id
card_write_status
sync_status
model_used
model_tier
did_sub_mode
prompt_contract_version
runtime_packet_id
has_multimodal_input
evaluation_status
```

### Detailní analýza `(1)`

Rozsáhlá profesionální strukturovaná analýza:

- průběh,
- reakce části,
- klinicky významné prvky,
- hypotézy jasně oddělené od doložených faktů,
- co je evidence-limited,
- význam pro konkrétní část,
- význam pro kluky jako celek,
- rizika,
- doporučení.

### Praktický report `(2)`

Krátký použitelný report pro denní práci:

- co se stalo,
- co to znamená,
- co dělat dnes,
- co nedělat,
- jak část podpořit,
- co připravit na další Hernu/Sezení.

### Týmové uzavření u Sezení

Report ze Sezení musí končit sekcí:

```text
Týmové uzavření
```

Obsah:

- poděkování terapeutce/terapeutkám,
- ocenění konkrétní práce,
- věta posilující kontinuitu a soudržnost týmu.

## 8. Karlův přehled

### Sekce `Včerejší herna`

Zobrazit:

1. úvodní věty generované vysokou inteligencí,
2. praktický report `(2)`,
3. závěr: význam pro část, pro kluky jako celek a doporučení terapeutkám,
4. rozbalovací tlačítko:

```text
Přečíst si detailní analýzu ze včerejší herny
```

### Sekce `Vyhodnocení včerejšího sezení`

Upravit tak, aby dashboard neukazoval celou detailní analýzu na ploše.

Zobrazit:

1. úvodní věty,
2. praktický report `(2)`,
3. týmové uzavření,
4. rozbalovací tlačítko:

```text
Přečíst si detailní analýzu ze včerejšího sezení
```

## 9. Odborné zdroje a internet

Při návrhu programu, týdenním směru a měsíčním směru může Karel používat odborné zdroje/internet, ale s anti-halucinačními pravidly.

Každý zdrojový vstup musí mít:

- URL nebo identifikaci zdroje,
- datum přístupu,
- stručné odůvodnění relevance,
- míru jistoty,
- poznámku, zda jde o obecnou inspiraci nebo odborně závazný podklad.

Karel nesmí:

- vymýšlet názvy testů,
- generovat neveřejné testové položky,
- generovat chráněné diagnostické klíče,
- předstírat citaci bez zdroje.

U chráněných testů/manuálů smí doporučit legitimní odborné použití, ne reprodukovat neveřejný obsah.

## 10. Klinická safety vrstva

Herna i Sezení musí mít safety router.

Spouštěče:

- sebepoškozování,
- suicidalita,
- akutní disociativní destabilizace,
- ztráta orientace,
- extrémní flashback,
- přímé ohrožení,
- obsah vyžadující okamžitý lidský zásah.

Chování:

- nepokračovat jako běžná Herna/Sezení,
- přepnout do stabilizačního režimu,
- upozornit terapeutky,
- vytvořit krizový záznam,
- zachovat auditní stopu.

## 11. Týdenní a měsíční směry

### Týdenní analýza

Jednou týdně zpracovat části aktivní za posledních 7 dní:

- DID/Kluci vlákna,
- Herna,
- Sezení,
- terapeutická vlákna o části.

Výstup:

```text
TÝDENNÍ SMĚR PRO PLÁNOVÁNÍ
```

Použití:

- ranní briefing,
- návrh dnešní Herny,
- návrh dnešního Sezení.

### Měsíční analýza

Jednou měsíčně zpracovat části aktivní za posledních 30 dní.

Výstup:

```text
MĚSÍČNÍ STRATEGICKÝ SMĚR
```

Použití:

- dlouhodobé cíle,
- terapeutický plán,
- plánování následujícího měsíce,
- nižší váha než týdenní směr a poslední aktivita.

## 12. Model routing a audit

Použití modelů:

- živá Herna: rychlý multimodální model,
- pre-flight runtime packet: těžký model,
- detailní analýza `(1)`: těžký model,
- praktický report `(2)`: těžký model nebo kontrolovaný druhý průchod,
- ranní syntéza v Karlově přehledu: těžký model,
- jednoduchá klasifikace/logování: lehčí model nebo deterministická logika.

Každý běh loguje:

```text
model_used
model_tier
did_sub_mode
prompt_contract_version
runtime_packet_id
has_multimodal_input
has_drive_sync
evaluation_status
sync_status
```

## 13. Doporučené pořadí implementace

### Fáze 1 – Stabilizační patch

- oprava `karel-chat` ReferenceError,
- Herna contract,
- multimodální normalizace,
- fallback UI,
- logování model/submode/contract.

### Fáze 2 – Sezení contract a schvalovací guard

- `THERAPIST_SESSION_ASSISTANT_CONTRACT`,
- blokování startu bez schváleného programu,
- runtime packet.

### Fáze 3 – Vyhodnocení Herny a Sezení

- `Ukončit hernu`,
- detailní analýza `(1)`,
- praktický report `(2)`,
- částečná/neukončená sezení.

### Fáze 4 – Drive/kartoteka_DID synchronizace a 03:00 scheduler

- povinné Drive dokumenty/linky,
- zápis do karty části,
- sync status,
- retry/logování.

### Fáze 5 – Karlův přehled

- sekce `Včerejší herna`,
- upravené `Vyhodnocení včerejšího sezení`,
- rozbalovací detailní analýzy.

### Fáze 6 – Týdenní/měsíční směry a odborné zdroje

- týdenní review aktivních částí,
- měsíční review aktivních částí,
- anti-halucinační zdrojová evidence,
- zapojení do návrhu programů.

## 14. Ověření

Ověřit:

- Herna nespadne při chybě backendu do prázdna.
- Karel v Herně nepoužívá běžné vlákno.
- Poslední vstup dítěte je explicitně v promptu.
- Multimodální vstup je zachycen i v následné paměti/reportu.
- Sezení vede terapeutku, ne dítě.
- Start Herny/Sezení je blokován bez schválení.
- Částečná sezení bez ukončení jsou vyhodnocena jako částečná/evidence-limited.
- Report má DB záznam, Drive výstup i zápis do karty části.
- Karlův přehled má `Včerejší herna` a rozbalovací detail.
- Sezení report obsahuje týmové uzavření.
- Safety router přepíná rizikový obsah mimo běžnou Hernu/Sezení.
- Logy ukazují model, tier, submode, contract version a sync status.

## Poznámka k aktuálnímu `.lovable/plan.md`

Současný schválený patch `QA-MVP-SESSION-1` je záměrně úzký a neopravuje celý tento systém. Tento doplněný plán je cílová specifikace pro další fáze, ne rozšíření aktuálního malého QA patch scope.