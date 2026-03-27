
Cíl:
- V režimu Hana opravit dvě věci přesně podle zadání:
  1. uvítací blok („Ahoj, Hani…“, „Nová konverzace“, „Vlákna“) musí být opravdu v levém spodním rohu,
  2. „Správa“ se musí přesunout do horní lišty vedle „← Zpět / Hana“ a zmizet z vnitřku stránky.

Co je teď špatně:
- V `src/components/hana/HanaChat.tsx` je nahoře stále interní toolbar se „Správa“, takže zabírá vertikální prostor a rozhodí pozici welcome bloku.
- Welcome část je sice oddělená `flex-1`, ale celý layout ještě obsahuje horní obsah uvnitř komponenty, proto blok nekončí skutečně dole.
- `src/pages/Chat.tsx` horní lištu pro Hanu už renderuje, ale „Správa“ tam dosud není doplněná.

Plán úpravy:
1. Vyčistit vršek stránky Hana
- V `src/components/hana/HanaChat.tsx` odstranit celý interní horní řádek se `Popover` tlačítkem „Správa“.
- Nechat v komponentě jen pozadí + hlavní obsah, bez vlastního headeru.

2. Ukotvit welcome blok skutečně dole vlevo
- V `HanaChat.tsx` přestavět neaktivní stav (`!chatStarted`) tak, aby hlavní wrapper zabíral celou dostupnou výšku a obsah byl zarovnán přes `justify-end` + `items-start`.
- Welcome blok dát do kontejneru s jasným spodním odsazením (`pb-*`) a levým odsazením (`px-*`), bez prvků nad ním, které by ho zvedaly.
- „Nová konverzace“ a „Vlákna“ ponechat pod textem ve stejném levém sloupci.

3. Přesunout „Správa“ do globální horní lišty
- V `src/pages/Chat.tsx` do Hana headeru vedle tlačítka zpět a titulku „Hana“ přidat tlačítko/popover „Správa“.
- Obsah popoveru zachovat funkčně stejný jako nyní v `HanaChat.tsx` (archiv, osvěžení paměti, bootstrap, kartotéka), jen přesunout renderování do skutečné horní lišty.

4. Propojit akce „Správa“ s Hana obrazovkou
- Protože logika akcí je nyní uvnitř `HanaChat.tsx`, zavedu čistý způsob sdílení:
  - buď přes props/callback registraci z `HanaChat` do `Chat.tsx`,
  - nebo přes malý lokální context pro Hana header actions.
- Vyberu variantu, která zasáhne nejméně souborů a nerozbije současné chování.

5. Zachovat ostatní požadavky
- Pozadí s nahranou fotkou zůstane napevno přes celou stránku.
- „Vzhled“ zůstane pro Hanu skrytý.
- „Vlákna“ zůstane dole vlevo pod „Nová konverzace“, ne v horní liště.

Technické detaily:
- Soubory:
  - `src/components/hana/HanaChat.tsx`
  - `src/pages/Chat.tsx`
  - případně malý nový helper/context jen pokud bude potřeba pro přenos akcí „Správa“
- Klíčová změna layoutu:
```text
Hana page
┌ header (globální, sticky)
│ ← Zpět | Hana | Správa | ...
└ content area (full height)
  └ bottom-left stack
    - Ahoj, Hani
    - podpůrný text
    - Nová konverzace
    - Vlákna
```

Výsledek po implementaci:
- Texty už nebudou nahoře ani u čela postavy.
- Budou opravdu vlevo dole, na tmavé části saka/ramene.
- „Správa“ bude nahoře v liště vedle „← Zpět / Hana“, přesně jak požaduješ.
