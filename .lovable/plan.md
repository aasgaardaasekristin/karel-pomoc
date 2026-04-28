# Plán opravy: porady na dashboardu, podpisy 2/2 a závazný výstup do Spižírny

## Co jsem zjistil

Konkrétní porada **„Krizová porada: Zhoršení stavu Tundrupka – únava a diskomfort“** je v databázi už fakticky schválená:

```text
status = approved
Hanička podepsala
Káťa podepsala
Karel timestamp existuje jen jako auditní stopa
final_summary existuje
karel_synthesis existuje
```

Takže problém není v tom, že by tato porada nebyla v DB schválená. Problém je v prezentační a synchronizační vrstvě dashboardu:

1. dashboard / karta stále mluví jazykem starého 3-podpisového modelu,
2. v některých místech se stále zobrazuje Karel jako chybějící podepisující,
3. karta neukazuje explicitně stav „porada schválena“ + `podpisy 2/2`,
4. po podpisu není zajištěené okamžité parent refresh propojení mezi modalem a dashboard kartou,
5. výstup do Spižírny B už existuje, ale je příliš slabý a není formulovaný jako závazný výsledný report porady pro další terapeutické vedení.

## Cíl opravy

Porady budou mít jednotné pravidlo:

```text
Schválení porady = podpis Haničky + podpis Káti.
Karel není podepisující osoba.
Karlův timestamp je jen auditní serverová stopa po schválení.
Dashboard nikdy nesmí ukazovat podpisy 0/3 ani „chybí Karel“.
```

Dashboard má ukazovat například:

```text
otevřená · podpisy 0/2 · chybí Hanička, Káťa
čeká na podpis · podpisy 1/2 · chybí Káťa
porada schválena · podpisy 2/2
```

## 1. Sjednotit signoff model v typu porady

Upravím `src/types/teamDeliberation.ts` tak, aby dokumentace i helper `signoffProgress()` byly jednoznačně dvoupodpisové pro všechny běžné porady:

- total vždy `2`,
- signers pouze `hanka`, `kata`,
- missing nikdy neobsahuje `karel`,
- `karel_signed_at` zůstává pouze auditní pole, ne UI podpis.

Současně odstraním zastaralé komentáře v souboru, které ještě popisují trojnásobný podpis jako pravdu.

## 2. Opravit dashboard kartu porad

V `src/components/did/TeamDeliberationsPanel.tsx` upravím render řádku porady:

- pro `status = approved` nebo `closed` se badge změní z nejasného „uzavřeno“ na **„porada schválena“**,
- podpisová věta bude používat jen `Hanička` a `Káťa`,
- nebude existovat žádný text „chybí Karel“,
- karta bude zřetelně odlišovat:
  - otevřená bez podpisů,
  - čeká na podpis druhé terapeutky,
  - schválená.

Také opravím text sekce „Další otevřené porady“, aby se do ní nestrkaly schválené karty pod zavádějícím názvem. Buď budou schválené karty v samostatném bucketu „Nedávno schválené“, nebo se v overflow popisku nebude tvrdit, že jsou otevřené.

## 3. Opravit refresh po podpisu

V `DidContentRouter.tsx` je `refreshTrigger` teď konstantní `0`, takže parent panel nemá jasný signál, že modal právě změnil poradu.

Upravím to takto:

```text
DeliberationRoom po podpisu / syntéze / uzavření zavolá onChanged()
PracovnaSurface zvýší refreshTrigger
TeamDeliberationsPanel a KarelOverviewPanel znovu načtou data
```

Důsledek: když se v modalu podepíše Hanička nebo Káťa, karta na dashboardu se hned přepočítá na `1/2` nebo `2/2`, bez čekání na náhodný realtime event.

## 4. Opravit modal porady, aby nikde netvrdil 3 podpisy

V `DeliberationRoom.tsx` zachovám správný dvoupodpisový model:

- v hlavičce `podpisy 0/2`, `1/2`, `2/2`,
- badge `Schválily: Hanička, Káťa`,
- žádný požadavek na Karlův podpis,
- u schválené porady text „Odpovědi, podpisy a Karlova syntéza jsou uzavřené“ upravím přesněji podle typu:
  - krizová porada: obsahuje Karlovu syntézu,
  - session_plan: obsahuje finální program / plán, ne starou syntézu.

## 5. Backend: schválení musí vždy vytvořit závazný výsledný report do Spižírny B

V `supabase/functions/karel-team-deliberation-signoff/index.ts` už existuje zápis do `karel_pantry_b_entries`, ale zpřesním ho tak, aby nebyl jen krátká poznámka „porada uzavřena“, nýbrž kanonický **výsledný report porady**.

Při přechodu do `approved` se zapíše do Spižírny B záznam s obsahem:

```text
- název porady
- typ porady
- dotčená část / části
- kdo podepsal
- že porada byla schválena 2/2
- Karlovo klinické vyhodnocení / final_summary
- závazné důsledky pro terapii
- závazné důsledky pro terapeutický tým
- další doporučený krok
- případná krizová rizika / ochranné signály
- vazba na linked_crisis_event_id / linked_live_session_id
```

Pro krizové porady použiji `karel_synthesis` a `final_summary` jako primární zdroj. Pro session_plan použiji schválený program / plan bridge.

Tento záznam bude mít:

```text
source_kind = team_deliberation
entry_kind = state_change nebo conclusion
intended_destinations = briefing_input + případně crisis_event_update / did_therapist_tasks
source_ref = deliberation_id
```

A doplním anti-dup logiku, aby opakovaný refresh nebo znovupodpis nevložil duplicitní „schváleno“ záznam pro stejnou poradu.

## 6. Ranní Karlův přehled musí schválenou poradu výslovně zohlednit

`karel-did-daily-briefing` už čte Spižírnu B i nedávné porady. Zpřesním prompt tak, aby pro schválené porady typu `team_deliberation` / `crisis` musel v ranním přehledu zohlednit:

```text
- která porada byla schválena,
- čeho se týkala,
- co z ní vyplynulo,
- jak se k tomu dnes terapeuticky postavíme.
```

Nebude stačit, že to AI „může použít“. Prompt dostane povinnost: pokud existuje čerstvý schválený poradní výstup ve Spižírně B, musí být promítnut do greeting / last_3_days / decisions podle klinické relevance.

## 7. Jednorázová oprava existujících nekonzistentních porad

Provedu databázovou opravu pro existující řádky, které mají:

```text
hanka_signed_at is not null
kata_signed_at is not null
status != approved
```

Tyto porady se překlopí na `approved` a doplní se auditní `karel_signed_at`, pokud chybí. Tím se opraví i historické karty, které jsou fakticky podepsané 2/2, ale zůstaly viset jako otevřené.

Zároveň ověřím konkrétní Tundrupkovu krizovou poradu a případně doplním / deduplikuji její Spižírna B záznam, aby se dostala do dalšího Karlova ranního přehledu.

## 8. Ověření po implementaci

Po změnách ověřím:

1. `signoffProgress()` vrací pro rozpracovanou poradu jen `0/2`, `1/2`, `2/2`.
2. Dashboard nikdy nezobrazí `0/3` ani `chybí Karel`.
3. Po podpisu Haničky karta ukáže `podpisy 1/2 · chybí Káťa`.
4. Po podpisu Káti karta ukáže `porada schválena · podpisy 2/2`.
5. Schválená krizová porada má záznam ve Spižírně B jako závazný report.
6. Ranní briefing prompt dostává tento report jako povinný vstup.

## Dotčené soubory

- `src/types/teamDeliberation.ts`
- `src/components/did/TeamDeliberationsPanel.tsx`
- `src/components/did/DeliberationRoom.tsx`
- `src/components/did/DidContentRouter.tsx`
- `supabase/functions/karel-team-deliberation-signoff/index.ts`
- `supabase/functions/karel-did-daily-briefing/index.ts`
- databázová migrace pro opravu historických stavů a případně anti-dup index / kontrolu Spižírny B

## Poznámka k Herna program binding plánu

Tato oprava je samostatná, ale související. Neodstraňuje předchozí plán tvrdého napojení Herny na schválený `playroom_plan`. Naopak: opravuje poradní workflow, ze kterého schválené plány a závazná rozhodnutí vznikají, aby dashboard a ranní Karel pracovaly se skutečně schváleným stavem.