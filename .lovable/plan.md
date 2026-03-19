
Ano — teď je to pořád špatně a důvod je v kódu jasně vidět.

Co se pokazilo:
1. V detailu úkolu se stále nahoře zobrazuje `task.task` jako nadpis i po rozkliknutí. Tím pádem i když je dole `detail_instruction`, už vizuálně vzniká duplicita proti tomu, co jsi chtěl: po kliknutí se text nemá zopakovat, ale změnit na plné vysvětlení.
2. Současná ochrana proti duplicitě řeší jen „jestli dole zobrazit další blok“, ale neřeší hlavní problém: horní krátký text zůstává po rozkliknutí vidět.
3. U části úkolů `detail_instruction` vůbec není kvalitně naplněné. V parseru je vidět fallback větev, kde se plný text zahodí a uloží se jen zkrácený název. Proto pak detail nemá z čeho vzniknout.
4. V denním cyklu se pro Karlovu práci stále používá hlavně `task` + `note`, ne plnohodnotné `detail_instruction`. Tím se bohatší instrukce nepřenášejí důsledně dál.

Co přesně opravit:
1. `DidTherapistTaskBoard.tsx`
- V rozbaleném stavu přestat zobrazovat horní text úkolu jako stejný název.
- Rozbalení má místo toho ukázat jen krátký label v hlavičce karty a pod ním jediný hlavní blok s plnou instrukcí.
- Pokud je detail obsahově stejný jako krátký label, nesmí se vyrenderovat znovu vůbec.
- Jinak řečeno: žádné „krátký text nahoře + skoro stejný text dole“.

2. `parseOverviewTasks.ts`
- Opravit fallback větve, které dnes zahazují plný obsah a ukládají prázdné `detail_instruction`.
- Vždy oddělit:
  - `task` = krátký akční název do seznamu
  - `detail_instruction` = plná srozumitelná instrukce
- U starších a neformátovaných vstupů ukládat plný původní text raději do `detail_instruction`, ne ho ztratit.

3. `karel-did-daily-cycle/index.ts`
- Obohatit generování `detail_instruction`, aby neobsahovalo jen „co udělat“, ale i proces úkolování:
  - úroveň spolupráce,
  - kde to vázne,
  - co jde dobře,
  - na co se zaměřit konkrétně teď,
  - co zlepšit v dalším kroku.
- Denní cyklus musí pracovat primárně s `detail_instruction`, ne jen s `note`.

Jak bude vypadat správný výsledek:
- Sbalený úkol: krátký, stručný název.
- Rozbalený úkol: plná, jasná instrukce bez opakování názvu.
- Detail má být užitečný a konkrétní, ne useknutý ani slovně zdvojený.

Jak bych to ověřil po opravě:
1. Otevřít úkol ze screenshotu a zkontrolovat, že se krátký text už po rozkliknutí nedubluje.
2. Ověřit, že detail obsahuje plnou instrukci, ne jen zbytek stejné věty.
3. Vytvořit nový úkol z Karlova přehledu a ověřit, že parser vyplní `detail_instruction`.
4. Spustit denní cyklus a ověřit, že nové instrukce obsahují i stav spolupráce, bloky, co funguje a konkrétní další fokus.

Shrnutí:
Nešlo o „jemné dolaďování deduplikace“, ale o chybnou architekturu zobrazení. Oprava musí udělat dvě věci zároveň:
- v UI skutečně nahradit krátký text plným detailem,
- v datech konečně důsledně ukládat plnou instrukci, aby bylo co zobrazit.
