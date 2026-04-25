Schvaluji směr opravy, ale plán platí pouze s níže uvedenými závaznými upřesněními. Cílem není lokální záplata `yesterday_session_review`, ale garantovaný lifecycle plánovaného DID sezení podle DOK1/DOK2/DOK3 v omezeném bezpečném rozsahu A–H.

## Bezpečný scope této implementace

Implementovat nyní:

A. Připravit backfill Arthur 24. 4.  
B. Zavést jednotný lifecycle plánovaného DID sezení  
C. Zavést jednotnou backend cestu `finalizeDidSession(planId, source, reason)`  
D. Opravit ranní safety-net podle kalendářního dne  
E. Opravit briefing fallback, aby sekce včerejšího sezení nemizela  
F. Zavést `did_session_reviews` jako primární runtime review  
G. Připravit projekce review přes `did_pending_drive_writes`  
H. Přidat základní testy

Neimplementovat teď jako velký refaktor:
- plný DOK3 dashboard pavouk,
- kompletní session packet redesign,
- plnou FACT/INFERENCE/PLAN/UNKNOWN evidence vrstvu,
- plný freshness/confidence model.

Pro tyto vrstvy se mají připravit jen datové háčky, nikoli velký zásah do dashboardu.

## 1. `karel-did-daily-cycle`: pouze minimální safety-net úprava

V `karel-did-daily-cycle` se smí změnit pouze minimální safety-net logika:
- nahradit pravidlo „starší než 18 hodin“ pravidlem podle kalendářního dne,
- najít včerejší plánovaná DID sezení bez review,
- předat je do samostatné finalizační/evaluační cesty.

Do daily-cycle se nesmí přidávat nová velká klinická logika. Daily-cycle nesmí dále bobtnat jako monolit.

Finalizace sezení, sběr evidence, zápis review a projekce patří do:
- `karel-did-session-finalize`,
- a/nebo existujícího evaluatoru `karel-did-session-evaluate`, upraveného tak, aby zapisoval `did_session_reviews`.

## 2. Lifecycle plánovaného DID sezení

Sjednotit stavy plánovaného DID sezení:

- `planned`
- `in_progress`
- `awaiting_analysis`
- `analyzed`
- `partially_analyzed`
- `evidence_limited`
- `failed_analysis`
- `cancelled`

Pravidla:
- `completed` / `done` bez review není platný klinicky finální stav.
- Každé sezení s `planId` musí mít po skončení dne auditovatelný výstup nebo explicitní důvod, proč není plná analýza možná.
- Včerejší `in_progress`, `awaiting_analysis`, `completed` / `done` bez review nesmí zůstat bez zásahu.
- `evidence_limited` je legitimní klinický stav, nikoli chyba.
- `failed_analysis` musí mít důvod chyby a možnost retry.

## 3. `did_session_reviews` jako primární auditní záznam

Vytvořit / sjednotit primární runtime záznam review v tabulce `did_session_reviews`.

Minimální pole:
- `id`
- `user_id`
- `plan_id`
- `part_name`
- `session_date`
- `status`: `analyzed`, `partially_analyzed`, `evidence_limited`, `failed_analysis`, `cancelled`
- `review_kind`
- `analysis_version`
- `source_data_summary`
- `evidence_items jsonb`
- `completed_checklist_items`
- `missing_checklist_items`
- `transcript_available`
- `live_progress_available`
- `clinical_summary`
- `therapeutic_implications`
- `team_implications`
- `next_session_recommendation`
- `evidence_limitations`
- `projection_status`
- `retry_count`
- `error_message`
- `created_at`
- `updated_at`

`evidence_items` je povinné auditní pole. Musí zachytit, z čeho review vzniklo, například:
- plán sezení,
- checklist,
- live progress,
- transcript,
- turn-by-turn data,
- terapeutické odpovědi,
- audio / obrázek / přílohy,
- dostupnost nebo nedostupnost jednotlivých důkazů.

Review nesmí být pouze textové shrnutí bez dohledatelného evidence základu.

Pro jeden `plan_id` smí existovat maximálně jedno aktuální review. Opakované spuštění finalizace, safety-netu nebo připraveného backfillu nesmí vytvořit duplicitní review, ale musí aktualizovat existující záznam nebo skončit jako idempotentní no-op.

## 4. Jednotná backend cesta `finalizeDidSession`

Zavést backend funkci / cestu se semantikou:

```text
finalizeDidSession(planId, source, reason)
```

Musí:
1. ověřit existenci `planId`,
2. načíst plán,
3. načíst live progress, checklist, transcript a další dostupnou evidenci,
4. uložit nebo uzavřít live progress,
5. nastavit plán na `awaiting_analysis`,
6. spustit evaluator,
7. vytvořit nebo aktualizovat `did_session_reviews`,
8. nastavit výsledný auditovatelný stav,
9. připravit projekce přes frontu,
10. nikdy nesmí jen změnit stav na `completed` / `done` bez review.

Všechny UI cesty ukončení plánovaného DID sezení s `planId` musí směřovat sem nebo na ekvivalentní jednotnou backend cestu:
- Ukončit,
- Ukončit sezení,
- Ukončit a analyzovat,
- Uložit transcript,
- Ukončit live asistenci,
- Opustit plánované sezení.

## 5. Backfill Arthur 24. 4. pouze připravit, nespouštět bez potvrzení

Implementace má umět najít Arthurův plán z 24. 4., načíst dostupná data a vytvořit review jako:
- `partially_analyzed`, pokud existují částečná data,
- nebo `evidence_limited`, pokud data nestačí.

Backfill musí rozlišit:
- co se skutečně stalo,
- co se nestihlo / neproběhlo,
- co nelze bezpečně vyhodnotit,
- co z toho plyne pro Arthura,
- co z toho plyne pro další terapeutický plán,
- co má tým udělat dál.

Samotný backfill Arthur 24. 4. a přegenerování dnešního Karlova přehledu se nesmí spustit bez dalšího explicitního potvrzení uživatele.

## 6. Briefing fallback: sekce nesmí zmizet

Karlův přehled nesmí skrýt sekci „Vyhodnocení včerejšího sezení“ jen proto, že hotová analýza chybí.

Fallback pořadí:
1. najít `did_session_reviews` za včerejšek,
2. pokud není, najít včerejší session plan,
3. pokud existuje plan, najít live progress / checklist / transcript,
4. pokud existuje částečný progress, zobrazit „Vyhodnoceno částečně“ nebo „Čeká na doplnění“,
5. pokud existuje plan bez dat, zobrazit „Evidence-limited — chybí podklady“,
6. pokud existuje `awaiting_analysis`, zobrazit „Vyhodnocení čeká / bylo spuštěno automaticky“,
7. sekci potlačit pouze tehdy, pokud včera neexistoval žádný plán, live sezení ani relevantní progress.

Nadpis sekce nesmí zmizet kvůli chybějícímu řádku ve staré tabulce.

## 7. Projekce do Drive a PAMET_KAREL

Po vytvoření review se projekce připravují přes existující frontu `did_pending_drive_writes`, nikoli přímým nahodilým zápisem.

Cíle projekcí:
1. karta části: klinická dedukce a implikace, ne syrový přepis,
2. `05A_OPERATIVNI_PLAN`: konkrétní implikace pro nejbližší dny,
3. Karlův přehled: sekce včerejšího sezení, doporučení, missing evidence,
4. `PAMET_KAREL`: pouze relevantní týmová/pracovní paměť.

Závazné omezení pro `PAMET_KAREL`:
- zapisovat jen závěry o spolupráci Haničky/Káti, zátěži, stylu vedení, týmových vzorcích nebo Karlových pracovních poznatcích,
- klinické závěry o části patří primárně do review, karty části a 05A,
- nemíchat osobní/týmovou paměť terapeutek s klinickou pamětí části.

Projekce do Drive, 05A a PAMET_KAREL se vytvářejí pouze z úspěšně uloženého `did_session_reviews` záznamu. Pokud vznikne `failed_analysis`, nesmí se do Drive nebo karty části propsat klinický závěr jako hotová pravda. Smí vzniknout pouze technický záznam o selhání, missing-evidence položka nebo retry úkol.

## 8. Entity guardrails

Při propsání závěrů do karty části musí být část ověřena.

Pravidla:
- potvrzená část nesmí vzniknout z AI odhadu,
- musí být ověřena proti registru / indexu / existující kartě / schválené alias vrstvě,
- neznámá entita nesmí vytvořit novou kartu ani `KARTA_*`,
- nejasná entita vytvoří follow-up otázku,
- ne-části patří do kontextu, ne do kartotéky částí.

Povinné příklady:
- Locík / Locik = pes, nikdy DID část,
- Zelená vesta = popis / atribut, ne část,
- Indián = nepotvrzená entita, ověřit otázkou,
- Lobcang / Lobchang = alias Lobzhang pouze pokud je potvrzen alias vrstvou,
- diakritika nesmí rozhodovat.

Default: pokud entita není ověřena, je `uncertain_entity`, ne `confirmed_part`.

## 9. Doplňující závazná pravidla

1. Idempotence review:  
Pro jeden `plan_id` smí existovat maximálně jedno aktuální review. Opakované spuštění `finalizeDidSession`, safety-netu nebo připraveného backfillu nesmí vytvořit duplicitní review. Musí buď aktualizovat existující záznam, nebo skončit jako idempotentní no-op.

2. Projekce jen z uloženého review:  
Projekce do Drive, 05A a PAMET_KAREL se vytvářejí pouze z úspěšně uloženého `did_session_reviews` záznamu. Pokud vznikne `failed_analysis`, nesmí se do Drive nebo karty části propsat klinický závěr jako hotová pravda. Smí vzniknout pouze technický záznam o selhání, missing-evidence položka nebo retry úkol.

## 10. Testy

Přidat/provést minimálně testy:
1. včerejší `in_progress` sezení se ráno automaticky předá k analýze,
2. progress 1/5 vytvoří `partially_analyzed`,
3. plán bez progressu vytvoří `evidence_limited`,
4. chyba analýzy vytvoří `failed_analysis`,
5. Karlův přehled zobrazí sekci i při chybějící hotové analýze,
6. všechny UI cesty ukončení plánovaného sezení volají jednotnou finalizační cestu,
7. briefing fallback najde včerejší plan i bez starého `did_part_sessions` review,
8. review vytvoří projekce přes `did_pending_drive_writes`,
9. opakované spuštění finalizace nevytvoří duplicitní review,
10. `failed_analysis` nevytvoří klinickou projekci jako hotový závěr,
11. neznámá entita nevytvoří `KARTA_*`,
12. nejistá entita vytvoří follow-up otázku,
13. Locík se nikdy nezpracuje jako DID část,
14. Lobcang/Lobchang se mapuje na Lobzhang jen při potvrzené alias vazbě.

## 11. Výstup po implementaci

Po dokončení vypsat pouze:
1. co přesně bylo změněno,
2. které soubory / backend funkce / tabulky byly dotčeny,
3. jaké lifecycle stavy sezení teď existují,
4. jak funguje `finalizeDidSession`,
5. jak funguje ranní safety-net,
6. jak briefing najde nebo zobrazí včerejší sezení,
7. kam se ukládá primární review,
8. jaké projekce vznikají do Drive / 05A / PAMET_KAREL,
9. jaké testy prošly,
10. co zůstává mimo scope.

## Potvrzení

S těmito závaznými upřesněními je plán schválen k implementaci:

1. `karel-did-daily-cycle` upravit pouze minimálně, bez dalšího bobtnání monolitu.
2. `did_session_reviews` musí obsahovat auditní `evidence_items jsonb` a provozní pole `review_kind`, `analysis_version`, `projection_status`, `retry_count`.
3. Pro jeden `plan_id` smí existovat maximálně jedno aktuální review; opakované běhy musí být idempotentní.
4. Projekce se vytvářejí pouze z úspěšně uloženého review; `failed_analysis` nesmí vytvořit klinický závěr jako hotovou pravdu.
5. Projekce do `PAMET_KAREL` musí být omezené na týmovou/pracovní paměť, ne klinickou paměť části.
6. Backfill Arthur 24. 4. a přegenerování dnešního přehledu pouze připravit; nespouštět bez explicitního potvrzení.
7. Entity guardrails musí zabránit vzniku karet z AI odhadu.

Doplňující závazná pravidla:

1. Idempotence review:
Pro jeden `plan_id` smí existovat maximálně jedno aktuální review. Opakované spuštění `finalizeDidSession`, safety-netu nebo připraveného backfillu nesmí vytvořit duplicitní review. Musí buď aktualizovat existující záznam, nebo skončit jako idempotentní no-op.

2. Projekce jen z uloženého review:
Projekce do Drive, 05A a PAMET_KAREL se vytvářejí pouze z úspěšně uloženého `did_session_reviews` záznamu. Pokud vznikne `failed_analysis`, nesmí se do Drive nebo karty části propsat klinický závěr jako hotová pravda. Smí vzniknout pouze technický záznam o selhání, missing-evidence položka nebo retry úkol.
