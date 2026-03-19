
Cíl: opravit rozpoznání identity části tak, aby Karel bral sloupec B v registru na Drive jako autoritativní zdroj jména + aliasů, a aby se stejná logika použila i při „Osvěž paměť“ a v overview.

Co jsem ověřil
- V nahrané tabulce je přesně ten formát, který popisuješ:
  - `ARTHUR (ARTUR, ARTÍK)`
  - `DMYTRI (DYMI, DYMKO)`
- To znamená: text před závorkou je kanonické jméno části, texty v závorce jsou aliasy téže identity.
- `karel-did-part-detect` to dnes neparsuje. Bere celou buňku B jako jeden slepený string.
- `DidPartIdentifier.tsx` už detektor volá, takže UI není hlavní problém.
- `karel-did-context-prime` dnes registry sheet z `00_CENTRUM` pro alias mapu nenačítá, takže „Osvěž paměť“ v tomto bodě nefunguje tak, jak potřebuješ.
- `karel-did-system-overview` používá vlastní logiku, takže bez sjednocení resolveru by se identity dál rozpadaly.

Co opravím
1. Zavedu jednotné parsování sloupce B
- Z buňky typu `ARTHUR (ARTUR, ARTÍK)` vytvořit:
  - canonical: `ARTHUR`
  - aliases: `ARTUR`, `ARTÍK`
- Matching bude:
  - case-insensitive
  - bez diakritiky
  - proti hlavnímu jménu i každému aliasu zvlášť
  - podřetězec bude platná shoda, jak požaduješ

2. Opravím live detekci identity
- `karel-did-part-detect` bude hledat v Drive registru podle aliasů ze sloupce B.
- Pokud uživatel zadá `artík`, vrátí se kanonická část `ARTHUR`.
- Výstup resolveru doplním o informaci, který alias byl skutečně trefen.

3. Napojím stejnou logiku na „Osvěž paměť“
- `karel-did-context-prime` bude při refreshi načítat registry sheet z `00_CENTRUM`.
- Z něj sestaví alias mapu a vloží ji do situační cache.
- Tím bude Karel po refreshi vědět, že aliasy jsou totožné identity, nejen při vstupu do vlákna, ale i v lokálním kontextu.

4. Sjednotím overview a agregace
- `karel-did-system-overview` přepojím na stejný resolver.
- Přehled pak nebude posuzovat `ARTUR / ARTÍK / ARTHUR` jako různé identity.
- Stejná logika se použije i pro seskupování recentních vláken.

5. Omezím riziko dalších chyb
- Resolver bude mít prioritu:
  1. Drive alias map
  2. DB registry names
  3. fuzzy fallback
- Tím se zabrání tomu, aby hrubý fuzzy match přebil explicitní alias ze sloupce B.

Soubory k úpravě
- `supabase/functions/karel-did-part-detect/index.ts`
- `supabase/functions/karel-did-context-prime/index.ts`
- `supabase/functions/karel-did-system-overview/index.ts`
- volitelně sdílená utilita v `supabase/functions/_shared/...` pro:
  - normalizaci textu
  - parsování `Jméno (alias1, alias2)`
  - lookup aliasů

Implementační poznámka
- Není problém to naprogramovat.
- Problém v aktuálním stavu je čistě v tom, že kód dnes neparsuje závorky ve sloupci B a nepoužívá tuto tabulku při refreshi paměti jako aliasový registr.
- Oprava je přímá: sloupec B se musí číst jako seznam ekvivalentních jmen jedné části.

Výsledek po opravě
- `artík` -> `ARTHUR`
- `artur` -> `ARTHUR`
- `dymi` -> `DMYTRI`
- „Osvěž paměť“ znovu natáhne aliasovou mapu z `00_CENTRUM`
- Overview i další DID funkce budou pracovat s jednou kanonickou identitou místo fragmentace jmen
