## Co jsem ověřil

Chyba nevznikla v zobrazení briefingu. Briefing jen převzal už špatně uložené vyhodnocení sezení.

V databázi je u sezení Tundrupek 2026-04-23 uložen text:
- „Stav: sotva začaté · vyhodnoceno automaticky ráno“
- „Sezení bylo ukončeno bezpečnostním protokolem hned v úvodu“
- „žádný z plánovaných bloků nebylo možné realizovat“

To je nepravda vůči tomu, co popisuješ. Příčina je kombinace tří věcí:

1. Živý checklist ukládá průběh hlavně do prohlížeče, ne průběžně do backendu.
2. Ranní bezpečnostní automat našel plán jako `in_progress` bez `completed_at` a zavolal vyhodnocení s `endedReason='auto_safety_net'`, ale bez počtu dokončených bodů, bez poznámek a bez turn-by-turn dat.
3. Evaluátor z prázdných důkazů a příznaku `auto_safety_net` dovolil AI udělat definitivní závěr „sotva začaté“. Následná ochrana idempotence pak bránila tomu, aby se tato špatná verze snadno přepsala bohatšími daty.

## Cíl opravy

Karel už nesmí z absence dat dělat klinický závěr. Když nemá důkazy o průběhu, musí říct „nemám záznam o formálním ukončení / nemám dost dat“, ne „sezení se neuskutečnilo“.

Zároveň se musí průběh živého sezení ukládat autoritativně do backendu už během práce, aby ranní proces měl skutečná data i bez kliknutí na „Ukončit a vyhodnotit“.

## Implementační plán

### 1. Přidat autoritativní ukládání průběhu živého sezení

Vytvořím novou backendovou tabulku pro průběžný stav programu, například `did_live_session_progress`:

- `plan_id`
- `user_id`
- `part_name`
- `therapist`
- `items` jako JSON seznam bodů programu, stav hotovo/nehotovo, pozorování
- `turns_by_block` jako JSON
- `artifacts_by_block` jako JSON
- `completed_blocks`
- `total_blocks`
- `last_activity_at`
- `finalized_at`
- `finalized_reason`

Nastavím RLS tak, aby uživatel četl a zapisoval jen vlastní data.

### 2. Napojit LiveProgramChecklist na průběžný sync

`LiveProgramChecklist` nechá lokální cache jako rychlou zálohu, ale při každé významné změně bude ukládat stav i do backendu:

- zaškrtnutí bodu
- vložení pozorování
- změna konverzace v bloku
- případně artefakty
- kliknutí na „Ukončit a vyhodnotit“

Při načtení checklistu se bude nejdřív brát backendový stav, ne jen localStorage. Tím se zabrání ztrátě reality sezení při refreshi, změně zařízení nebo ranním cyklu.

### 3. Upravit evaluátor, aby používal backendový průběh jako důkaz

`karel-did-session-evaluate` doplním tak, že pokud request nepřinese `completedBlocks`, `turnsByBlock` nebo `observationsByBlock`, načte si je z `did_live_session_progress` podle `planId`.

Doplním tvrdý guard:

- pokud `completedBlocks / totalBlocks` ukazuje, že většina programu proběhla, AI nesmí vrátit `abandoned` ani formulace typu „neuskutečnilo se“
- pokud není žádný průběhový důkaz, u `auto_safety_net` se nevygeneruje definitivní klinický závěr, ale „předběžný administrativní záznam bez dostatečných dat“
- výstup musí jasně rozlišit „sezení nebylo formálně uzavřeno“ od „sezení neproběhlo“

### 4. Zastavit ranní safety-net před výrobou nepravdivých klinických závěrů

V `karel-did-daily-cycle` upravím Phase 8A.5:

- před voláním evaluátoru načte `did_live_session_progress`
- pokud existuje průběh, pošle reálné `completedBlocks`, `totalBlocks`, poznámky a turny
- pokud průběh neexistuje, neoznačí to za „sotva začaté“; buď pouze zapíše administrativní poznámku, nebo zavolá evaluátor v režimu „insufficient_evidence“
- nebude přepisovat bohatší/manuální evaluaci chudší automatickou verzí

### 5. Opravit konkrétní nepravdivý záznam Tundrupek 2026-04-23

Po implementaci přegeneruji vyhodnocení konkrétního včerejšího sezení s `force=true`, ale už s bezpečnostním zadáním:

- sezení proběhlo téměř celé
- nedokončily se jen některé body
- nový text nesmí tvrdit, že sezení neproběhlo, bylo přerušeno hned na začátku nebo že bezpečnostní protokol znemožnil realizaci

Pokud z uložených dat nebude možné rekonstruovat přesný obsah všech bodů, Karel to přizná jako omezení záznamu, ale nebude si vymýšlet opak reality.

### 6. Obnovit denní briefing z opravené analýzy

Po opravě `did_part_sessions.ai_analysis` znovu vygeneruji dnešní denní briefing, aby „přetlumočení Karlovy analýzy“ vycházelo z opraveného vyhodnocení.

## Technické detaily

Dotčené části:

- `src/components/did/LiveProgramChecklist.tsx`
- `supabase/functions/karel-did-session-evaluate/index.ts`
- `supabase/functions/karel-did-daily-cycle/index.ts`
- případně `supabase/functions/karel-did-daily-briefing/index.ts` pouze pro navazující regeneraci
- nová migrace pro tabulku `did_live_session_progress`

Nová logika bude pracovat podle principu:

```text
absence záznamu != důkaz, že sezení neproběhlo
neformálně ukončeno != sotva začaté
většina bodů hotová != abandoned
automatická chudá evaluace nesmí přebít bohatší realitu
```

## Výsledek

Po schválení provedu opravu tak, aby:

- konkrétní záznam o Tundrupkovi přestal obsahovat nepravdivá tvrzení,
- dnešní briefing vycházel z opravené reality,
- příště Karel nemohl z nedostatku dat vyrábět falešné klinické závěry,
- průběh sezení byl uchován i bez ručního finálního kliknutí.