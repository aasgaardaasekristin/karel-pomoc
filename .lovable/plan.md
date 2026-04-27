Rozumím. Tohle už není jen „prompt neposlechl“ — našel jsem skutečný konstrukční bug:

1. Herna sice předává Karlovi schválený program, ale zároveň se postup bloků ve frontendu posouvá automaticky po každé odpovědi dítěte. Proto se v databázi aktuální Herna tváří jako dokončená 5/5 bloků, i když reálně program nebyl projitý.
2. Strukturovaný program má aktuálně jen obecné klíče `block/detail/minutes`, zatímco starý runtime čeká `title/method/child_facing_prompt_draft/karel_response_strategy`. Výsledkem je, že guard často nemá konkrétní „kolej“, ke které má Karla vracet.
3. Backend guard dnes kontroluje jen shodu s jedním promptem a předčasné loučení. Neumí vynutit pořadí: počasí → symbolická postava → jeden malý krok → ukotvení → závěr. Proto Karel sklouzne do krásného, ale volného rozhovoru a znovu si sám uzavírá.

Navrhuji opravit to tvrdě takto:

## 1. Zastavit automatické dokončování bloků
- V `DidKidsPlayroom.tsx` odstraním logiku, která po každé dětské odpovědi automaticky označí aktuální blok jako hotový.
- Blok se posune jen tehdy, když runtime výslovně vyhodnotí, že byl splněn, nebo když dítě odpovědělo na přesně očekávaný mikro-krok.
- Současná situace „completed_blocks = 5/5“ už nebude vznikat po pár výměnách.

## 2. Zavést programový krokový stroj pro Hernu
Pro každý blok vytvořím normalizovaný runtime krok bez ohledu na to, jestli plán obsahuje `block/detail/minutes` nebo novější detailní pole.

Příklad pro aktuální program:

```text
0 Bezpečný práh
1 Mapa dnešního vnitřního počasí
2 Symbolická hra s jednou postavou
3 Co potřebuje malý krok
4 Měkké uzavření
```

Runtime bude vědět:
- aktuální blok,
- co už dítě poskytlo,
- co má Karel udělat teď,
- co je zakázané,
- kdy smí přejít dál.

## 3. Přepsat Karlovu odpověď do „rail composeru“, ne jen prompt guardu
Když AI ujede mimo program, nenechám ji jen znovu vyzvat promptem. Backend vytvoří povinnou opravenou odpověď podle aktuálního bloku:

- krátké navázání na poslední vstup dítěte,
- explicitní návrat k dalšímu bodu programu,
- jedna konkrétní A/B volba nebo mikro-aktivita,
- žádné loučení mimo poslední blok.

U aktuálního příkladu by Karel po „křídla se nad chlapečkem roztáhla. Už brzy bude doma“ neměl uzavírat, ale pokračovat dalším blokem, např. převést symbol velrybího chlapečka do bodu „jeden malý krok pro tělo/kontakt/klid“.

## 4. Zpřísnit detekci off-rail chování
Doplním guardy pro:
- samovolné uzavírání: „dnešní hru uzavřeme“, „odpočívej“, „přeju“, „jsem rád, že jsme našli“, „už nemusíte nic“;
- pasivní setrvání bez dalšího programového kroku;
- symbolický únik nahoru/Bůh/hvězda/křídla, pokud není přetaven do bezpečného dalšího kroku;
- opakované kroužení v jednom symbolu bez návratu k programu;
- cizí jazyk v Herně.

## 5. Tvrdě zresetovat rozpracovanou Hernu pro Tundrupka
Po opravě runtime upravím aktuální stav tak, aby Tundrupek mohl pokračovat:
- `did_live_session_progress` pro dnešní schválený program nastavím zpět na správný nedokončený stav, pravděpodobně na blok „Symbolická hra s jednou postavou“ nebo „Co potřebuje malý krok“ podle dosavadního transcriptu.
- Herna nebude považovaná za hotovou jen proto, že stará logika chybně označila 5/5 bloků.
- Stávající transcript zachovám jako historii, ale další odpovědi už pojedou přes nový krokový runtime.

## 6. Přidat auditní stopu pro vynucení programu
Do runtime auditu doplním rozlišení:
- `playroom_step_advanced`,
- `playroom_step_stayed`,
- `playroom_rail_guard_replaced`,
- `playroom_forced_program_resume`.

Tím půjde poznat, jestli Karel skutečně postupuje podle programu, nebo jestli ho guard musel opravit.

## Technické změny
- `src/components/did/DidKidsPlayroom.tsx`
  - opravit progresní logiku,
  - normalizovat kroky programu,
  - neposouvat blok automaticky po každé odpovědi,
  - posílat backendu jasný runtime stav.

- `supabase/functions/karel-chat/index.ts`
  - doplnit normalizaci playroom kroků,
  - nahradit slabý keyword guard krokovým guardem,
  - přidat deterministic rail composer pro každý blok,
  - vynutit češtinu a zákaz samovolného závěru,
  - zapisovat auditní důvody.

- Lovable Cloud databáze
  - opravit aktuální `did_live_session_progress` pro dnešní Tundrupkovu Hernu, aby mohl pokračovat podle programu místo falešného stavu 5/5.

## Očekávaný výsledek
Karel nebude volně vést „hezký rozhovor“ mimo plán. Bude reagovat na Tundrupka, ale vždy ho vrátí k dalšímu bodu schváleného programu. Ukončení bude možné jen v posledním bloku, přes tlačítko „Ukončit hernu“, explicitní stop dítěte nebo bezpečnostní důvod.