# Oprava Herny: program binding + bezpečné neukončování

Tento plán nahrazuje původní dílčí opravu. Cílem už není jen zabránit předčasnému ukončování, ale pevně napojit Hernu na schválený `playroom_plan` tak, aby Karel nejel jako volný chat s počítadlem, ale jako programově řízené, auditovatelné Karel-led sezení.

## Jádro opravy

Herna nebude řízená volným chatem ani samotným počítadlem `completed_blocks`. Každý turn bude řízen aktuálním blokem schváleného `playroom_plan`, jeho cílem, dětsky bezpečnou instrukcí, povolenými aktivitami, completion criteria, posledním vstupem dítěte a backendovým rozhodnutím o progressu založeným na evidenci.

Autoritativní řetězec musí být:

```text
approved playroom_plan
  -> konkrétní plan_id
  -> konkrétní thread_id Herny
  -> aktuální block_id
  -> completion criteria
  -> POSLEDNÍ VSTUP DÍTĚTE
  -> backendové rozhodnutí o posunu
  -> evidence každého dokončeného bloku
```

## Klinická hranice

Cílem není nutit dítě dokončit celý program za každou cenu.

Správné pravidlo je:

```text
Karel nesmí sám od sebe předčasně uzavřít Hernu, pokud dítě chce pokračovat a není safety důvod.
```

Program se může zastavit nebo přerušit pouze pokud:

- dítě jasně řekne stop / nechci pokračovat / končím / stačí,
- vznikne bezpečnostní důvod,
- terapeutka ručně ukončí režim,
- nebo je stisknuto tlačítko „Ukončit hernu“.

Pokud dítě píše „co dál?“, „co teď dál?“ nebo „co budeme dělat teďka?“, je to continuation signal, ne closing signal a ne completion signal.

## 1. Povinné předání identity Herny do backendu

`DidKidsPlayroom.tsx` musí při každém turnu posílat do `karel-chat` tvrdé identifikátory:

- `mode = "playroom"`,
- `didSubMode = "playroom"`,
- `session_actor = "karel_direct"`,
- `ui_surface = "did_kids_playroom"`,
- `lead_entity = "karel"`,
- `planId`,
- `threadId`,
- `partId` / `partName`,
- lokální progress pouze jako neautoritativní hint.

Historické `sub_mode = "karel_part_session"` nesmí přebít rozhodování podle `mode = "playroom"`, `session_actor = "karel_direct"` a `ui_surface = "did_kids_playroom"`.

Frontend nebude hlavní autorita pro posun programu. Bude pouze zobrazovat stav, posílat vstup dítěte a ukládat thread.

## 2. Backend musí ověřit `planId`, ne mu slepě věřit

`planId` z frontendu je pouze identifikátor/hint. Backend musí ověřit, že:

- `planId` patří k danému `threadId`,
- thread patří dané části,
- thread je dnešní / aktuální Herna,
- uživatel má oprávnění s tímto threadem pracovat,
- plán je ve stavu `approved`, `ready_to_start` nebo `in_progress`,
- plán je opravdu určený pro dětskou Hernu.

Thread Herny musí být pevně svázaný s plánem, ideálně přes:

```text
workspace_id = planId
workspace_type = playroom_plan
mode = playroom
session_actor = karel_direct
ui_surface = did_kids_playroom
```

Backend nesmí párovat Hernu s programem jen podle data a jména části.

## 3. Backend bude načítat schválený `playroom_plan`

V `karel-chat` musí playroom větev při každé odpovědi:

1. vzít `planId` z requestu,
2. ověřit vazbu `planId` ↔ `threadId`,
3. načíst přesně tento schválený `playroom_plan`,
4. ověřit metadata:
   - `session_actor = karel_direct`,
   - `ui_surface = did_kids_playroom`,
   - `lead_entity = karel`,
   - `approved_for_child_session = true`,
   - existuje `playroom_plan.therapeutic_program`,
5. odmítnout použít `plan_markdown`, `first_draft` nebo terapeutické Sezení jako náhradní program.

Tvrdé pravidlo:

```text
Herna smí používat pouze validní approved playroom_plan.
```

Pokud validní `playroom_plan` chybí, dítěti se nesmí zobrazit technická zpráva. Dítě dostane bezpečný check-in, například:

```text
Dnes začneme jen malým bezpečným krokem. Neotevřu teď nic těžkého, dokud pro to nemám připravený plán.
```

Terapeutkám se interně zobrazí/audituje:

```text
Chybí validní approved playroom_plan. Herna neběží v plném programovém režimu.
```

## 4. Normalizace bloků programu

Backend vytvoří normalizační vrstvu pro `therapeutic_program`, aby každý blok měl stabilní runtime tvar:

```ts
{
  block_id,
  index,
  title,
  goal,
  child_safe_instruction,
  allowed_activities,
  minimum_completion_criteria,
  do_not_advance_when,
  forbidden_directions,
  fallback
}
```

Když starší plán nemá explicitní `block_id` nebo criteria, backend je bezpečně odvodí z existujících polí, ale do auditu zapíše, že criteria byla odvozená.

Každý blok musí mít minimálně:

- cíl,
- dětsky bezpečnou instrukci,
- povolené aktivity,
- minimum completion criteria,
- podmínky, kdy neposouvat,
- zakázané směry.

## 5. Prompt musí obsahovat program i poslední vstup dítěte

Backendový prompt musí obsahovat dva povinné bloky:

```text
AKTUÁLNÍ PROGRAM HERNY
POSLEDNÍ VSTUP DÍTĚTE
```

Karel musí odpovídat na průnik obou:

```text
program + poslední vstup dítěte = další odpověď Karla
```

Do promptu se vloží runtime packet:

```text
AKTUÁLNÍ PROGRAM HERNY:
- plan_id:
- thread_id:
- part_name:
- current_block_id:
- current_block_index:
- current_block_title:
- current_block_goal:
- child_safe_instruction:
- allowed_activities:
- minimum_completion_criteria:
- do_not_advance_when:
- forbidden_directions:
- fallback:
- program_completed:
- playroom_finalized:
```

A současně:

```text
POSLEDNÍ VSTUP DÍTĚTE:
- raw_text:
- detected_intent:
- continuation_signal:
- stop_signal:
- safety_signal:
- candidate_completion_evidence:
```

Karel nesmí jet slepě podle programu a ignorovat dítě. Zároveň nesmí reagovat jen na dítě a ignorovat aktuální blok programu.

## 6. Backendové rozhodování o progressu

Značka `[PLAYROOM_PROGRESS:advance]` už nebude autoritativní.

Progress rozhoduje backend podle:

- posledního vstupu dítěte,
- aktuálního bloku,
- completion criteria,
- odpovědi Karla,
- stop / continuation / safety signálů,
- historie daného bloku.

Výsledkem bude `progress_decision`:

```text
stay
advance
blocked
fallback
stop_requested
safety_stop
manual_therapist_stop
post_program_holding
```

Backend nesmí vyhodnotit blok jako dokončený pouze podle odpovědi Karla. Dokončení bloku musí být opřené hlavně o:

- odpověď dítěte,
- splněné completion criteria,
- ruční zásah terapeutky,
- nebo safety důvod.

Blok se nesmí označit jako completed pouze proto, že:

- Karel položil otázku,
- Karel nabídl aktivitu,
- dítě napsalo „co dál?“,
- dítě napsalo pouze „nevím“,
- AI vrátila `[PLAYROOM_PROGRESS:advance]`.

Příklad: pokud Karel řekne „Vyber A, B nebo C“, blok ještě není hotový. Completion evidence může vzniknout až po odpovědi dítěte, například „A, někdo blízký vedle něj“.

Progress tagy jako `[PLAYROOM_PROGRESS:advance]` nesmí být viditelné pro dítě. Ideálně se progress rozhodnutí vrací jako server-side metadata / structured output, ne jako text v odpovědi Karla.

## 7. Evidence každého completed blocku

Při každém skutečném posunu backend uloží evidence:

- `block_id`,
- `completion_reason`,
- `evidence_message_id` / `turn_id`,
- `child_response_excerpt`,
- `karel_action_excerpt`,
- `criteria_matched`,
- `decision_source`,
- `completed_at`,
- případně `blocked_reason`.

`child_response_excerpt` a `karel_action_excerpt` jsou určené pro audit, terapeutky a pozdější analýzu. Nesmí se automaticky zobrazovat dítěti.

Cílem je, aby už nikdy neexistovalo jen:

```text
completed_blocks = 5
```

bez důkazu, proč jsou bloky dokončené.

## 8. Idempotence a ochrana proti race condition

Progress update musí být idempotentní a chráněný proti souběžným turnům.

Pravidla:

- jeden `message_id` / `turn_id` nesmí posunout blok více než jednou,
- dva rychlé požadavky nesmí přeskočit dva bloky,
- backend musí před zápisem znovu ověřit aktuální `current_block_id`,
- pokud stav mezitím změnil jiný turn, druhý turn musí skončit jako `blocked` nebo `stale_turn`.

## 9. `completed_blocks = total_blocks` bez `finalized_at`

Tyto tři stavy musí být oddělené:

```text
program_completed
playroom_finalized
review_generated
```

`completed_blocks = total_blocks` bez `finalized_at` neznamená ukončenou Hernu.

Pokud jsou všechny bloky skutečně dokončené, ale Herna není finalized, systém nepřejde automaticky do loučení a nemusí falešně opakovat starý blok. Použije bezpečný post-program holding / integration block, například:

```text
Teď už nemusíme otevírat nic těžkého. Můžeme udělat malý bezpečný krok: vybrat, co si velrybí mládě vezme s sebou, než se Herna ukončí.
```

Karel ale pořád nesmí Hernu sám uzavřít bez tlačítka, jasného stopu, terapeutického ukončení nebo safety důvodu.

## 10. Guardrail po odpovědi Karla

Po každé vygenerované odpovědi backend ověří:

- je odpověď v souladu s aktuálním blokem?
- navazuje na poslední vstup dítěte?
- dává další krok z programu?
- neuzavírá předčasně?
- nevymýšlí aktivitu mimo program?
- nepoužívá interní terapeutické formulace před dítětem?
- není příliš volná typu „co chceš dělat?“ místo programového mikro-kroku?

Pokud dítě píše „co teď dál?“, Karel musí odpovědět pokračováním z aktuálního programu, například u velrybího mláděte:

```text
Dobře, teď nebudeme končit. Půjdeme na další malý krok s velrybím mládětem.
Zkusíme zjistit, co by mu nejvíc pomohlo:
A) někdo blízký vedle něj,
B) bezpečné místo,
C) chvilka klidu bez mluvení.
```

Ne:

```text
Pro dnešek to uložíme a rozloučíme se.
```

A ne příliš volně:

```text
Co bys chtěl dělat?
```

## 11. Audit log pro každý playroom turn

Do audit metadata u každé playroom odpovědi se doplní:

- `plan_id`,
- `thread_id`,
- `playroom_plan_hash`,
- `runtime_packet_id`,
- `has_playroom_plan`,
- `has_runtime_packet`,
- `current_block_id`,
- `current_block_index`,
- `current_block_title`,
- `last_child_input_excerpt`,
- `detected_child_intent`,
- `progress_decision`,
- `progress_blocked_reason`,
- `completion_reason`,
- `criteria_matched`,
- `premature_closing_repaired`,
- `continuation_forced`,
- `used_plan_markdown: false`,
- `used_first_draft: false`,
- `used_session_plan_as_fallback: false`.

Tím půjde zpětně doložit, jestli Karel skutečně jel podle programu.

## 12. Oprava aktuální Tundrupkovy Herny

Po nasazení oprav se zkontroluje dnešní Tundrupkova Herna:

- použitý `plan_id`,
- aktivní `thread_id`,
- zda byl načten validní `playroom_plan`,
- `current_block_id` u posledních turnů,
- proč se bloky označily jako dokončené,
- zda existuje completion evidence,
- stav `completed_blocks = 5/5`,
- stav `finalized_at = null`.

Protože Herna není finalized, nesmí být považovaná za ukončenou. Historie se nemaže. Pokud jsou bloky důvěryhodně dokončené, použije se holding/integration block. Pokud evidence chybí, backend nesmí z tohoto stavu automaticky generovat závěr.

## 13. Testy / ověření

Doplnit testovací scénáře pro edge logiku a/nebo helpery:

1. Herna bez validního `playroom_plan` nepoužije terapeutické Sezení ani `plan_markdown`.
2. `planId` z frontendu se ověřuje proti `threadId` a není slepě důvěryhodný.
3. „co dál?“ neposune blok a nevygeneruje závěr.
4. `[PLAYROOM_PROGRESS:advance]` sám o sobě neposune blok bez splněných criteria.
5. Blok se neposune ve stejném turnu jen proto, že Karel položil otázku.
6. Completion vzniká až z odpovědi dítěte, ručního zásahu terapeutky nebo safety důvodu.
7. `completed_blocks = total_blocks` + `finalized_at = null` neznamená uzavřenou Hernu.
8. Pokud jsou bloky hotové, ale Herna není finalized, použije se `post_program_holding_block`.
9. Prompt/runtime obsahuje `AKTUÁLNÍ PROGRAM HERNY` i `POSLEDNÍ VSTUP DÍTĚTE`.
10. Odpověď Karla navazuje na unikátní symbol/aktivitu z programu.
11. Audit log obsahuje `plan_id`, `thread_id`, `current_block_id`, `playroom_plan_hash` a `progress_decision`.
12. Souběžné turny neposunou progress dvakrát.

## 14. Soubory k úpravě

### `src/components/did/DidKidsPlayroom.tsx`

- rozšířit request payload o `planId`, `threadId`, `mode`, `didSubMode`, `session_actor`, `ui_surface`, `lead_entity`,
- odstranit autoritativní frontend advance podle textové značky,
- progress zobrazovat podle backendového rozhodnutí,
- zajistit, že progress tagy nejsou viditelné dítěti,
- držet UI napojené na správný historický thread a správný `workspace_id = planId`.

### `supabase/functions/karel-chat/index.ts`

- načítat a validovat `playroom_plan` podle `planId`,
- ověřovat vazbu `planId` ↔ `threadId`,
- odmítnout fallback na `plan_markdown` / `first_draft` / terapeutické Sezení,
- normalizovat bloky programu,
- vytvářet runtime packet s `AKTUÁLNÍ PROGRAM HERNY`,
- vkládat `POSLEDNÍ VSTUP DÍTĚTE`,
- rozhodovat progress na backendu podle criteria a evidence,
- ukládat completion evidence,
- chránit progress update proti souběhu,
- zapisovat audit metadata,
- opravovat předčasné závěry na programové pokračování.

### `supabase/functions/karel-part-session-prepare/index.ts`

- zajistit, že thread Herny vzniká s vazbou `workspace_id = planId`,
- neotevírat duplicitní prázdnou Hernu, pokud dnešní reálná aktivita existuje,
- nepřepínat aktivní thread na novější prázdný plán bez zpráv.

## 15. Důkaz po implementaci

Po opravě musí být možné pro poslední Tundrupkovu Hernu ukázat:

1. `plan_id`,
2. `thread_id`,
3. `playroom_plan_hash`,
4. zda byl načten validní `playroom_plan`,
5. `current_block_id` u posledních 5 turnů,
6. runtime blok `AKTUÁLNÍ PROGRAM HERNY` u jednoho turnu,
7. runtime blok `POSLEDNÍ VSTUP DÍTĚTE` u jednoho turnu,
8. `progress_decision` u posledních 5 turnů,
9. `completion_reason` a evidence pro každý completed block,
10. proč `completed_blocks = 5/5` nevygenerovalo finalized stav,
11. jak systém odpověděl na „co teď dál?“.

## Očekávaný výsledek

Herna bude programově řízené, auditovatelné Karel-led sezení. Karel nebude uzavírat Hernu bez explicitního důvodu, nebude improvizovat mimo schválený `playroom_plan`, nebude posouvat bloky bez evidence a nebude používat samotné `completed_blocks` jako důkaz, že Herna skutečně proběhla nebo byla ukončena.
