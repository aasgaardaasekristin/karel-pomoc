
# Oprava live sezení: po „Spustit sezení“ se má otevřít program bod po bodu, ne generický chat

## Co je teď skutečně špatně

Problém není jen ve scrollu. Problém je v tom, že je špatně navržená samotná obrazovka live sezení.

Teď se po `Spustit sezení` otevře `DidLiveSessionPanel`, který jako hlavní obsah ukáže:
- generický uvítací text „Hani, jsem tu s tebou…“
- hlavní chat pro celý průběh
- hint karty Karla
- plán schovaný až v rozbalovacím bloku nahoře

To je v přímém rozporu s tím, co potřebuješ:
- nejdřív vidět schválený plán sezení,
- kliknout na konkrétní bod programu,
- a teprve potom otevřít pracovní prostor toho bodu:
  - celý úkol,
  - Karlův konkrétní návod,
  - co má Hana říct,
  - jak to uvést,
  - co sledovat,
  - jaké pomůcky potřebuje,
  - přílohy,
  - krokový chat s Karlem.

Navíc současný layout míchá dohromady:
- globální chat,
- per-bod vedení,
- checklist,
- hint karty,

takže se důležitý obsah propadá mimo viditelnou část a terapeutka nevidí to, co reálně potřebuje pro práci s bodem.

## Cílové chování

Po kliknutí na:

`Návrh sezení k poradě → Otevřít poradu → Spustit sezení`

se musí otevřít live místnost ve 2 krocích:

### 1. Výchozí obraz live sezení = jen schválený plán
Ne generický chat.

Zobrazí se:
- hlavička live sezení,
- schválený plán sezení jako hlavní obsah,
- seznam bodů programu,
- u každého bodu tlačítko `Spustit bod`.

Bez velkého uvítacího odstavce.
Bez hlavního generického chatu přes celou obrazovku.

### 2. Po kliknutí na `Spustit bod` = otevře se pracovní prostor konkrétního bodu
Ten musí obsahovat vše potřebné pro práci s tím jedním bodem:

```text
[Zpět na plán]  [Bod 2: Název]
--------------------------------
Karlův brief k bodu
- co má Hana říct
- jak to uvést
- jaké pomůcky použít
- na co si dát pozor
- co sledovat
- proč tu techniku děláme

Přílohy / vstupy
[Fotka] [Obrázek] [Mikrofon] [Audio] [Video]

Krokový chat k tomuto bodu
Karel: první instrukce
Hana: zapíše reakci dítěte
Karel: další přesný krok
Hana: další reakce
...
```

Tohle už v kódu částečně existuje v `BlockDiagnosticChat`, ale je to teď zastrčené uvnitř checklistu místo toho, aby to bylo hlavní pracovní plátno bodu.

## Co upravím

### A. Předělám `DidLiveSessionPanel` z „globálního live chatu“ na „live program workspace“
Současný root flow změním takto:

- odstraním generický greeting jako hlavní první obraz,
- odstraním současné postavení „hlavní chat + hint karty“ jako výchozího středu obrazovky,
- přidám explicitní režimy obrazovky:

```text
mode = "plan_overview" | "block_workspace"
```

- `plan_overview` = seznam bodů schváleného plánu
- `block_workspace` = detail právě spuštěného bodu

### B. Checklist přesunu do hlavní plochy jako výchozí obraz
V `DidLiveSessionPanel.tsx`:
- `LiveProgramChecklist` už nebude schovaný jen v collapsible sekci,
- stane se hlavním obsahem po otevření live sezení,
- schválený plán bude scrollovatelný jako centrální obsah,
- po otevření se bude hned zobrazovat celý pracovní seznam bodů.

### C. `Spustit bod` přepne do dedikovaného workspace toho bodu
Místo toho, aby se Karlův obsah vyráběl do vedlejších hint karet a ztrácel se v toku:

- kliknutí na `Spustit bod` nastaví aktivní bod,
- přepne UI do `block_workspace`,
- nahoře bude jasné:
  - číslo bodu,
  - název bodu,
  - tlačítko `Zpět na plán`.

### D. Jako hlavní obsah bodu použiju `BlockDiagnosticChat`
To je přesně ten mechanismus, který už odpovídá tomu, co chceš:
- diagnostický brief,
- pomůcky,
- instrukce dítěti,
- co sledovat,
- očekávané artefakty,
- krokový mini-chat Karel ↔ Hana,
- per-bod ukládání turnů,
- retry při chybě.

Ale musím ho vytáhnout do hlavní plochy bodu, ne ho nechat schovaný jen po rozbalení v checklistu.

### E. Zruším zbytečný generický úvod „Hani, jsem tu s tebou…“
Ten text teď zabírá prostor a nepomáhá.

Místo něj bude u aktivního bodu rovnou konkrétní pracovní obsah:
- co říct,
- jak to uvést,
- proč ten krok děláme,
- co sledovat,
- co poslat jako přílohu.

### F. Sjednotím přílohy přímo s aktivním bodem
V block workspace budou jasně navázané akce:
- fotka / obrázek,
- mikrofon / audio,
- video,
- případně poznámka.

Každá příloha se bude vázat k aktivnímu bodu, ne „někam do obecného live panelu“.

### G. Opravím scroll na správném místě
V block workspace nastavím layout takto:

```text
[sticky header bodu]
[scrollovatelný obsah bodu]
[sticky input pro reakci Hany]
```

Tím bude vždy vidět:
- celý obsah bodu,
- Karlův brief,
- spodní chat input.

Nebude už situace, kdy:
- vidíš jen začátek karty,
- nevidíš celý úkol,
- nevidíš Karlův popis,
- nevidíš chatovací pole.

### H. Hint karty `KarelInSessionCards` přestanu používat jako hlavní místo instrukcí
Tyhle karty jsou teď jedna z hlavních příčin chaosu.

Použiju je maximálně jako vedlejší doplněk, nebo je pro block režim úplně vyřadím, aby:
- se instrukce nezobrazovaly „bokem“,
- Karlův konkrétní obsah byl vždy přímo v detailu aktivního bodu.

## Soubory k úpravě

1. `src/components/did/DidLiveSessionPanel.tsx`
   - hlavní refaktor obrazovky live sezení
   - zavedení `plan_overview` / `block_workspace`
   - odstranění generického startovacího toku jako hlavního obsahu
   - nový scroll ownership
   - sticky header + sticky input v detailu bodu

2. `src/components/did/LiveProgramChecklist.tsx`
   - zachovat checklist jako vstupní obraz
   - zjednodušit roli komponenty: seznam bodů + `Spustit bod`
   - případně odstranit závislost na skrytém inline detailu jako primárním UX

3. `src/components/did/BlockDiagnosticChat.tsx`
   - použít jako hlavní pracovní modul detailu bodu
   - případně doplnit lepší nadpisy / rozložení sekcí pro brief, pomůcky, instrukce, chat

4. `src/components/did/KarelInSessionCards.tsx`
   - omezit nebo vyřadit z hlavního toku aktivního bodu, aby nepřekážel

5. případně `src/components/did/DeliberationRoom.tsx`
   - jen ověřit, že po `Spustit sezení` se otevírá nový live workspace správně
   - bez změny backend logiky

## Technické poznámky

- Backend měnit není potřeba.
- Už existující endpointy pro per-bod logiku zůstanou:
  - `karel-block-research`
  - `karel-block-followup`
  - `karel-live-session-produce`
- Oprava je hlavně:
  - UI architektura,
  - rozvržení obrazovky,
  - přesun existující per-bod logiky do hlavního pracovního toku.
- Video upload doplním do UI pouze pokud v projektu už existuje použitelný upload pattern; jinak ho zařadím jako samostatný navazující krok po stabilizaci hlavního flow.

## Jak poznám, že je to konečně správně

1. Po `Spustit sezení` nevidím generický chat, ale rovnou schválený plán bod po bodu.
2. U každého bodu programu je `Spustit bod`.
3. Po kliknutí na bod se otevře samostatný pracovní prostor toho bodu.
4. V tom prostoru je vidět:
   - celý úkol,
   - Karlův konkrétní návod,
   - co má Hana říkat,
   - jak to uvést,
   - co sledovat,
   - pomůcky,
   - přílohy,
   - chatovací okno k tomu bodu.
5. Celý obsah bodu jde normálně scrollovat.
6. Spodní input pro odpověď Hany je vždy vidět.
7. Karlovy instrukce nejsou schované v nějaké malé kartě bokem nebo mimo viewport.
8. Terapeutka nemusí hádat, kam psát ani kde najde vedení ke konkrétnímu bodu.

## Priorita implementace

1. Nejprve opravím architekturu obrazovky live sezení.
2. Pak přepojím `Spustit bod` na dedikovaný workspace bodu.
3. Pak doladím scroll a sticky input.
4. Nakonec pročistím zbytečné prvky, které teď dělají chaos.
