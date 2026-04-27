Souhlasím — tohle je další bug z mé předchozí opravy. Guard sice Karla zastavil před volným uzavíráním, ale při vynuceném návratu na koleje začal dítěti ukazovat interní program: „Další bod je: Měkké uzavření… Cílem je…“. To do dětské Herny nepatří.

## Co opravím

### 1. Oddělím interní program od dětské řeči
Vynucovací odpověď už nikdy nesmí obsahovat:
- „Další bod je…“
- názvy bloků typu „Měkké uzavření“, „Symbolická hra“, „Co potřebuje malý krok“
- „Karel nabídne…“
- „Cílem je…“
- „dostupnost části“, „program“, „blok“, „terapeutický plán“, „schválený“

Interní krokový stroj zůstane pro řízení, ale dítě uvidí jen dětskou repliku.

### 2. Přepíšu backendový `buildPlayroomRailReply`
Současná problematická věta vzniká v backendu v `supabase/functions/karel-chat/index.ts`, kde fallback skládá odpověď takto:

```text
Slyším tě... Další bod je: {blockTitle}. {programPrompt}
```

To nahradím dětským composerem:

```text
Slyším tě, Tundrupku. Nekončíme, zůstaneme jen u jednoho malého kousku.
Vyber si: A) pošleš mi jedno slovo, B) pošleš jen obrázek/symbol, C) necháme chvilku ticho.
```

Podle aktuálního bloku se vytvoří dětská mikro-volba, ne opis terapeutického plánu.

### 3. Přepíšu frontendový `buildRailReply`
Stejný problém je i ve frontendu v `src/components/did/DidKidsPlayroom.tsx`. Pokud frontend zachytí off-rail odpověď, také nesmí vložit interní text plánu.

Frontend guard bude používat jen:
- krátké navázání na dítě,
- „nekončíme / zůstaneme u malého kousku“,
- jednu jednoduchou A/B/C volbu,
- žádné názvy programu.

### 4. Přidám tvrdý sanitizační filtr pro dětské odpovědi
Do Herny přidám finální kontrolu textu před uložením/zobrazením. Pokud odpověď obsahuje interní jazyk, bude nahrazena bezpečnou dětskou verzí.

Zakázané vzory:
```text
Další bod je
aktuální blok
programový krok
Měkké uzavření
Symbolická hra
Cílem je
Karel nabídne
terapeutický plán
schválený program
část / dostupnost části
runtime / index / blok
```

### 5. Opravím logiku posledního bloku
I když je aktuální blok „Měkké uzavření“, Karel ho nesmí dítěti pojmenovat klinicky. Dětská verze bude například:

```text
Teď to můžeme jen jemně položit, ne zavřít narychlo. Vyber si, co je pro tebe nejlepší: A) jedno malé slovo, B) jeden symbol, C) ticho a já budu potichu blízko.
```

Tedy: program se splní, ale dětskou řečí.

### 6. Resetnu/napravím aktuální pokračování Tundrupka
Po opravě zajistím, aby další odpověď navázala dětsky a podle programu, ne interním popisem. Pokud je uložená poslední špatná odpověď v threadu, upravím následnou návaznost tak, aby se Karel omluvně a jednoduše vrátil k Herně bez metajazyka.

## Technické změny

- `supabase/functions/karel-chat/index.ts`
  - přepsat `buildPlayroomRailReply`,
  - přidat `sanitizePlayroomChildVisibleText`,
  - odstranit child-facing vypisování `blockTitle` a `programPrompt`,
  - vynucovat dětské A/B/C formulace podle typu kroku,
  - auditovat zásah jako guard replacement, ale bez úniku interního textu.

- `src/components/did/DidKidsPlayroom.tsx`
  - přepsat `buildRailReply`,
  - rozšířit `blockedChildText`,
  - před uložením finální odpovědi kontrolovat interní jazyk,
  - při zachycení interního jazyka nahradit odpověď dětskou mikro-volbou.

## Očekávaný výsledek

Karel bude dál tvrdě držen programem, ale dítě neuvidí technický ani klinický plán. Herna bude znít jako rozhovor s dítětem:

```text
Slyším tě, Tundrupku. Trochu jsem to předtím řekl moc dospělácky; teď to zjednoduším.
Nekončíme narychlo, jen položíme jeden malý kousek.
Vyber si: A) jedno slovo, B) jeden symbol, C) ticho a já budu blízko.
```

Program zůstane závazný, ale jeho formulace bude skrytá.