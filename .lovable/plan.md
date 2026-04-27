Oprava bude cílit na hlavní problém: Herna teď sice otevře správné dětské UI, ale runtime Karla se nechová jako řízené sezení podle schváleného programu. Pouští se po asociaci, předčasně uzavírá a navíc mu jazykový detektor chybně přepnul do norštiny.

## Co opravím

1. **Tvrdý Playroom kontrakt v `karel-chat`**
   - Pro `didSubMode="playroom"` doplním samostatný, prioritní režim, který přebije obecný `cast` chat.
   - Karel bude mít explicitně zakázáno:
     - sám ukončit Hernu,
     - loučit se před dokončením programu,
     - přeskočit z bloku 2 rovnou na měkké uzavření,
     - „jen poeticky doprovázet“ bez pokračování programu.
   - Povinně bude pokračovat dalším krokem schváleného programu, dokud dítě samo nestiskne `Ukončit hernu`, neřekne jasné `stop/nechci`, nebo nenastane bezpečnostní signál.

2. **Stav programu po blocích, ne podle počtu user zpráv**
   - V `DidKidsPlayroom.tsx` přestanu určovat aktuální blok jen podle počtu odpovědí dítěte.
   - Zavedu lehký playroom progress tracker:
     - aktuální blok,
     - dokončené bloky,
     - poslední aktivní blok,
     - transcript a pozorování pro každý blok.
   - Progress se bude ukládat do existující `did_live_session_progress`, aby ranní briefing a vyhodnocení viděly skutečný průběh Herny.

3. **Prompt bude vždy obsahovat přesný aktuální blok**
   - Při každé odpovědi pošlu Karlovi:
     - celý schválený `therapeutic_program`,
     - aktuální blok,
     - bloky, které už byly dokončené,
     - pravidlo: pokud aktuální blok není dokončený, pokračuj v něm; pokud je dokončený, přejdi na další.
   - Karel nebude rozhodovat „už je konec“, pokud progress neukazuje, že je u posledního bloku.

4. **Ochrana proti předčasnému závěru**
   - Přidám kontrolu odpovědi z AI pro Hernu.
   - Pokud odpověď obsahuje vzorce typu „pro dnešek se loučíme“, „přeju ti zbytek dne“, „kdykoliv jsem tady“, „měj se hezky“ mimo poslední blok nebo bez stisku ukončovacího tlačítka, aplikace ji nepustí jako finální závěr.
   - V takovém případě buď:
     - odpověď nahradí bezpečným pokračováním aktuálního bloku, nebo
     - znovu zavolá Karla s korekcí „neukončuj, pokračuj blokem X“.

5. **Oprava chybného přepnutí do norštiny**
   - Jazyková adaptace teď platí i pro Playroom a chytá norská slova falešně z kontextu.
   - Pro Hernu nastavím výchozí jazyk `cs` a zákaz přepnout jazyk pouze podle interní chyby nebo krátkého falešného signálu.
   - Karel v Herně přepne jazyk jen tehdy, když dítě skutečně a souvisle píše cizím jazykem, nebo výslovně řekne, že chce jiný jazyk.
   - Pokud dítě řekne „piš česky“, čeština se okamžitě stane závazná pro zbytek Herny.

6. **Bezpečnostní reakce na obsah „chtěl bych být hvězdičkou“**
   - Karel nebude poeticky potvrzovat únik „vysoko pryč“ jako konečný stav a nebude to používat k uzavření.
   - Doplním pravidlo pro jemné vyhodnocení: takový motiv neznamená automaticky paniku, ale vyžaduje krátké bezpečnostní ukotvení a pokračování v programu, případně stop/fallback podle signálů.

7. **UI v Herně ukáže terapeutický průběh bez odhalení dítěti**
   - Do dětské Herny nepřidám klinický plán jako viditelný text pro dítě.
   - Přidám jen nenápadný interní stav pro runtime a případně malý terapeutický debug/indikátor jen v kódu/logice, ne jako child-facing obsah.
   - Dítě dál uvidí jen jednoduché věty, volby a aktivity.

## Technicky upravím

- `src/components/did/DidKidsPlayroom.tsx`
  - výpočet aktuálního bloku,
  - ukládání průběhu do `did_live_session_progress`,
  - silnější `didInitialContext` s `current_block` a `completion_state`,
  - guard proti předčasnému ukončování odpovědí.

- `supabase/functions/karel-chat/index.ts`
  - prioritní `PLAYROOM_SYSTEM_CONTRACT` pro Hernu,
  - čeština jako default pro Hernu,
  - oprava jazykové detekce tak, aby Playroom nepřepínal omylem do norštiny,
  - zákaz ukončení mimo poslední blok / bez explicitního stopu.

- případně `supabase/functions/karel-part-session-prepare/index.ts`
  - pokud bude potřeba, při přípravě Herny založím/obnovím progress řádek pro plán, aby druhá cesta přes `DID/Kluci/Herna` měla připravenou místnost i stav programu.

## Ověření po implementaci

- Build projde bez chyb.
- Simulovaný průběh podle uvedeného programu:
  1. Bezpečný práh,
  2. Mapa dnešního vnitřního počasí,
  3. Symbolická hra s jednou postavou,
  4. Co potřebuje malý krok,
  5. Měkké uzavření.
- Karel nesmí po druhém bloku sám ukončit Hernu.
- Karel zůstane česky.
- Tlačítko `Ukončit hernu` zůstane jediná normální cesta k formálnímu ukončení, pokud dítě samo neřekne stop.