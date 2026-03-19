
Cíl: opravit skutečný problém, ne jen kosmetiku. Teď je chyba dvojí:
1. Rozbalený úkol znovu vypisuje stejný text jako řádek nahoře, protože UI skládá `task + note` a když `note` není kvalitní nebo je prázdná, vznikne duplicita.
2. V mnoha úkolech vůbec neexistuje samostatná „plná instrukce“, takže aplikace po rozkliknutí nemá co zobrazit kromě zkráceného názvu.

Navržené řešení

1. Okamžitá logická oprava detailu úkolu
- V detailu po rozkliknutí přestat zobrazovat původní `task` text.
- Horní řádek zůstane jen jako krátký název/souhrn.
- Rozbalená část bude zobrazovat výhradně samostatné pole pro plnou instrukci.
- Pokud plná instrukce neexistuje, použije se `note` jen když není obsahově stejná jako `task`.
- Pokud je `note` prázdná nebo duplicitní, detail se nemá znovu vykreslit stejným textem.

2. Správný datový model, aby detail byl opravdu srozumitelný
Doporučuji přidat do úkolů nové pole, např. `detail_instruction`.
- `task` = krátký název do seznamu
- `detail_instruction` = plná, lidsky srozumitelná instrukce po rozkliknutí
- `note` = doplňující interní poznámka / kontext / důvod
Bez tohoto oddělení bude aplikace pořád narážet na to, že krátký název a detail jsou míchané dohromady.

3. Jak má ideálně vypadat obsah po rozkliknutí
Po rozkliknutí se má zobrazit blok ve stylu:
```text
Co má Hanička udělat:
- uzavřít staré úkoly z minulého týdne
- připravit podklady k jejich dokončení
- označit, co je hotové a co ještě chybí

Proč:
- aby byl přehled v plnění čistý
- aby Karel viděl, co je blokované a mohl navrhnout další krok
```
Tedy ne zopakovaná věta, ale přeložený, úplný instrukční text.

4. Odkud se má plná instrukce brát
Je potřeba ji generovat/ukládat už při vzniku úkolu:
- z Karlova přehledu
- z parsování overview textů
- z chatových návrhů úkolů
- z denního cyklu
Při importu doporučuji každý úkol rozdělit na:
- krátký label do seznamu
- konkrétní instrukci
- důvod / očekávaný výstup
Tím se odstraní dnešní problém, kdy parser jen usekne větu a UI pak nemá kvalitní detail.

5. Konkrétní oprava parseru
Současný parser řeší hlavně zkrácení textu. To nestačí.
Navrhuji změnit parser tak, aby vracel:
- `task` = stručný akční název
- `detail_instruction` = plná formulace
- `note` = doplňky
Pravidlo:
- nic neořezávat do detailu
- plný původní význam vždy zachovat
- do krátkého názvu se má dát jen stručný přehled, ne celá instrukce

6. Důvod, proč se to teď kazí
V aktuálním kódu je v detailu:
- nahoře `task`
- dole znovu `task + note`
To je přesně zdroj duplicity.
A současně parser negarantuje, že `note` obsahuje lepší vysvětlení.
Proto i po předchozích úpravách vznikl výsledek, který je vizuálně i obsahově špatně.

7. Doporučené další vylepšení této funkce
A. Dvouúrovňový úkol
- seznam: krátký přehled
- detail: jasná instrukce + proč + očekávaný výstup

B. Pole „hotovo znamená“
U každého úkolu mít stručné kritérium dokončení:
```text
Hotovo znamená: všechny staré úkoly mají stav, podklady jsou připravené a chybějící body jsou vypsané.
```

C. Karlův navazující krok
Pod instrukcí zobrazit:
- „Když se zasekneš, napiš Karlovi kde je blok.“
- „Další doporučený krok: …“
To zvyšuje dokončování úkolů.

D. Lepší práce s úkoly pro „obě“
U úkolů pro obě mít v detailu rozdělení:
```text
Hanička:
...
Káťa:
...
Společně:
...
```
Aby bylo jasné, co dělá kdo.

E. Využití v celé aplikaci
- denní cyklus může generovat nejen úkol, ale i plnou instrukci
- Karlův přehled může zobrazit jen label, detail zůstane na nástěnce
- zpětná vazba v task feedu může reagovat na konkrétní „další krok“, ne jen obecně motivovat

8. Co bych přesně provedl v implementaci
- upravit rendering detailu v `DidTherapistTaskBoard.tsx`, aby se nikdy nezobrazoval duplicitní text
- zavést samostatné pole pro plnou instrukci v datech úkolu
- upravit `parseOverviewTasks.ts`, aby generoval krátký název a plný detail odděleně
- doplnit fallback logiku: když detail není kvalitní, nezobrazit duplikát
- projít zdroje tvorby úkolů, aby všechny nové úkoly už nesly plnou instrukci správně

9. Ověření po opravě
- po rozkliknutí nesmí být nikde stejná věta dvakrát
- horní řádek má být stručný, spodní blok plný a srozumitelný
- u úkolu typu ze screenshotu se nesmí zobrazit jen stejná jedna věta, ale plné vysvětlení
- filtry Hanka / Káťa / Obě a Dnes / Zítra / Dlouhodobé je potřeba znovu ověřit jako regresní test

Technicky dotčené části
- `src/components/did/DidTherapistTaskBoard.tsx`
- `src/lib/parseOverviewTasks.ts`
- datový model `did_therapist_tasks` (doporučené nové pole `detail_instruction`)

Doporučení k výslednému UX
Nejefektivnější řešení je nepokoušet se „vymyslet detail až v UI“, ale ukládat ho od začátku jako samostatnou, plnou instrukci. Teprve to zajistí, že rozkliknutí opravdu nahradí stručný text jasným, adekvátním a užitečným vysvětlením.
