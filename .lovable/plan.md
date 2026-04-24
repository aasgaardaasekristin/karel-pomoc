## Co jsem zjistil

Karel už má základ profesionální vrstvy, ale je nedostatečný pro skutečně odbornou diagnostickou práci.

Aktuálně existuje:
- knihovna metod `karel_method_library`, ale jen s 9 stručnými seed manuály;
- pevné `clinicalPlaybooks.ts` pro Jungův asociační experiment, kresbu postavy, strom, HTP, KFD, CAT/TAT styl, sandtray, body map a bezpečné místo;
- živý bod sezení používá `karel-block-research` a `karel-block-followup`, takže Karel umí vést protokol krok za krokem;
- u asociačního experimentu se už 7× načetl manuál z knihovny a historie ukazuje 2 uzavřená použití.

Hlavní problém:
- Karel má protokoly pro vedení metody, ale nemá stejně pevný protokol pro profesionální vyhodnocení výsledků.
- Asociační experiment vyžaduje latence, verbatim odpovědi, afekt, neverbální projevy, perseverace, reprodukční kontrolu atd. Karel je sice umí vyžadovat, ale post-session evaluace je nevyhodnocuje podle samostatného skórovacího rámce.
- `karel-did-session-evaluate` ukládá obecné `methods_effectiveness`, ale nevyrobí strukturovaný diagnostický nález typu: stimulus → odpověď → latence → marker komplexu → interpretace → míra jistoty → co ověřit příště.
- Analýza obrázků (`karel-analyze-file`) je zatím obecná: „popiš co vidíš, navrhni doporučení“. Není napojená na konkrétní kresbové manuály a nevyžaduje standardizovaný záznam umístění, velikosti, pořadí kreslení, vynechaných částí, inquiry atd.
- ROR/Rorschach v systému reálně není implementovaný jako protokol. Je pouze zmíněn jako zdrojový kontext u Jungova experimentu. To znamená: Karel by teď neměl předstírat plnohodnotné ROR vyhodnocení.
- Vývojová diagnostika dítěte je zmíněná jen okrajově (např. Goodenough-Harris u kresby postavy), ale není z ní samostatná vývojová osa.

## Návrh opravy

### 1. Zavést „diagnostický důkazní protokol“

Doplnit nový jednotný datový rámec pro každou diagnostickou metodu:

```text
Metoda
  → požadované vstupy
  → povinné artefakty
  → měřené proměnné
  → skórovací / interpretační osa
  → limity validity
  → diferenciální vysvětlení
  → závěr s mírou jistoty
  → co ověřit příště
```

Karel potom nebude smět říct „z toho plyne X“, pokud v datech chybí povinný vstup.

Příklad u asociačního experimentu:
- bez latencí nesmí hodnotit komplexy podle latence;
- bez verbatim odpovědí nesmí analyzovat obsah odpovědí;
- bez reprodukční kontroly nesmí mluvit o reprodukčních chybách;
- pokud je záznam neúplný, musí výslovně napsat: „validita omezená, chybí…“.

### 2. Přidat samostatnou funkci pro profesionální analýzu metody

Vytvořit backend funkci `karel-method-analysis`, která nebude jen „obecně hodnotit sezení“, ale vyhodnotí konkrétní diagnostický materiál.

Pro Jungův asociační experiment bude výstup strukturovaný například:

```text
1. Kvalita dat
2. Tabulka stimulů
   - stimul
   - odpověď
   - latence
   - afekt
   - neverbální reakce
   - marker: normální / komplexový / vyhýbavý / trauma signál
3. Komplexové clustery
4. Trauma-informed interpretace
5. Vývojová přiměřenost odpovědí
6. Alternativní vysvětlení
7. Klinický závěr s jistotou
8. Doporučení pro další sezení
```

Tato analýza se uloží zpět do `did_part_sessions`, Pantry B a do historie metody.

### 3. Rozšířit knihovnu manuálů

Doplnit seed manuály a playbooky pro:

- asociační experiment: oddělit vedení testu od vyhodnocení;
- vývojovou diagnostiku dítěte: jazyk, kognitivní úroveň, hra, emoční regulace, sociální reciprocita, symbolizace, kresba podle vývoje;
- kresbové metody: Goodenough-Harris vývojová osa, Machover opatrně jako projektivní hypotézy, KFD/HTP/Koch s limity validity;
- ROR/Rorschach pouze jako „neadministrovat plný standardizovaný Rorschach bez licencovaného psychologa a kompletního protokolu“. Karel může maximálně připravit bezpečný projektivní inkblot-like rozhovor, ale musí jej označit jako nestandardizovaný, ne jako ROR skórování.

Tím se předejde tomu, aby Karel působil odborně, ale ve skutečnosti improvizoval.

### 4. Zpřísnit prompt v živém vedení bodu

U `karel-block-followup` doplnit pravidla:
- Karel musí během sezení hlídat, zda Hana/Káťa skutečně zapisují data potřebná k pozdější analýze;
- pokud chybí latence/verbatim/foto/audio, musí terapeutku ihned zastavit a požádat o doplnění;
- nesmí posunout protokol do `done`, pokud chybí minimální data pro validní analýzu, ledaže výslovně označí výstup jako „nevalidní / pouze orientační“.

### 5. Zpřísnit analýzu obrázků a audia

U `karel-analyze-file` a `karel-audio-analysis` doplnit režim `diagnostic_method`:
- pokud jde o kresbu, Karel nejdřív načte odpovídající manuál/playbook;
- odpověď bude rozlišovat „popis viditelného“ vs. „opatrná hypotéza“ vs. „nelze určit“;
- nebude dělat diagnostické závěry bez kontextu, post-drawing inquiry a vývojového věku;
- bude vyžadovat doplňující data: pořadí kreslení, instrukci, zda byla guma, formát papíru, věk části, verbatim komentáře.

### 6. Upravit závěrečné vyhodnocení sezení

`karel-did-session-evaluate` má po dokončení sezení:
- rozpoznat použité metody podle `method_id`;
- pro každou metodu zavolat/integrovat `karel-method-analysis`;
- do výsledného vyhodnocení vložit oddíl „Diagnostická validita“;
- jasně oddělit:
  - co je doložený nález,
  - co je hypotéza,
  - co je doporučení,
  - co chybí pro profesionální závěr.

### 7. UI doplněk pro terapeutku

V živém bodu sezení doplnit malý kontrolní checklist „Pro validní analýzu chybí“:
- verbatim odpovědi;
- latence;
- afekt/neverbální reakce;
- foto kresby;
- audio;
- post-test inquiry;
- reprodukční kontrola.

Cíl: Hana/Káťa hned uvidí, proč by pozdější Karlova analýza nebyla profesionální.

## Technické kroky

1. Rozšířit `clinicalPlaybooks.ts` o analytické sekce a validitu vstupů.
2. Rozšířit seed `karel-method-library-seed` o nové/hlubší manuály.
3. Vytvořit backend funkci `karel-method-analysis` se strukturovaným tool-calling výstupem.
4. Napojit `karel-block-followup` na povinné měřené proměnné a blokaci falešného `done`.
5. Napojit `karel-did-session-evaluate` na metodu‑po‑metodě diagnostickou analýzu.
6. Upravit `karel-analyze-file` a `karel-audio-analysis` pro diagnostické artefakty.
7. Upravit `BlockDiagnosticChat` / `LiveProgramChecklist`, aby UI zobrazovalo chybějící diagnostická data.
8. Doplnit testy na:
   - asociační test bez latencí → výstup musí říct „nelze validně hodnotit latence“;
   - ROR dotaz → Karel nesmí předstírat standardizované Rorschach skórování;
   - kresba bez inquiry → Karel musí označit závěr jako omezený;
   - kompletní asociační protokol → Karel vyrobí tabulkovou profesionální analýzu.

## Bezpečnostní / klinické pravidlo

Karel může být výborný supervizní a interpretační nástroj, ale nesmí předstírat standardizovanou psychodiagnostiku tam, kde nejsou splněny podmínky administrace, skórování a licence. Oprava tedy nebude jen „aby byl sebevědomější“, ale hlavně aby byl odbornější: bude přesnější, opatrnější, důkazní a transparentní v limitech.