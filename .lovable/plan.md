
Cíl opakuji přesně: opravit, proč se v Arturově vláknu nezobrazuje fotka na pozadí, a zabránit opakování stejné chyby.

Co jsem dohledal:
- Fotka není ztracená v datech. V databázi pro personu `kluci` stále existuje `background_image_url`.
- Arturovo vlákno v `did_threads.theme_config` teď obsahuje jen barvy/font/emoji, ale ne `background_image_url`.
- V `Chat.tsx` se při otevření vlákna aplikuje jen `thread.themeConfig`.
- `applyTemporaryTheme(...)` skládá dočasný vzhled nad aktuální `prefs`.
- Jenže `currentPersona` se do `kluci` nepřepíná při vstupu do DID-Kluci toku; přepíná se až při otevření editoru `DidKidsThemeEditor`.
- To znamená: Arturovo vlákno se teď skládá nad špatným základem (`default` persona bez fotky), ne nad globálním vzhledem `kluci`, kde ta fotka opravdu je.

Z toho plyne přesná příčina:
1. Fotka není smazaná.
2. Jen se nenačítá správný základ persony `kluci` před aplikací thread vzhledu.
3. Proto se použijí thread barvy bez foto-pozadí.
4. Dřívější „filtr prázdných hodnot“ problém jen zmírnil, ale neopravil hlavní bug.

Plán opravy:
1. Opravit zdroj pravdy pro DID-Kluci
- V `src/pages/Chat.tsx` při vstupu do DID-Kluci režimu explicitně přepnout theme personu na `kluci`.
- Zajistit, aby se před `handleSelectThread` pracovalo s načtenými preferencemi `kluci`, ne s `default`.

2. Opravit aplikaci thread vzhledu
- V `handleSelectThread` skládat thread vzhled nad globálními prefs persony `kluci`, ne nad náhodně aktuálním stavem.
- Tím zůstane Arturova globální fotka zachovaná, pokud ji thread výslovně nepřebíjí.

3. Opravit editor thread vzhledu
- V `src/components/did/DidKidsThemeEditor.tsx` při otevření thread editoru inicializovat draft z kombinace:
  - globální prefs `kluci`
  - plus uložený `thread.theme_config`
- Nejen z aktuálního `prefs`, které mohou být z jiné persony.
- Tím se zabrání ukládání „neúplného“ thread configu.

4. Opravit persistenci thread pozadí
- Když si vlákno nastaví vlastní pozadí, uložit ho do `did_threads.theme_config.background_image_url`.
- Když si vlastní pozadí nenastaví, nesmí se tím smazat globální klučičí fotka.

5. Opravit návrat z vlákna
- Při odchodu z threadu vždy obnovit globální `kluci` prefs, ne obecný poslední theme stav.
- Tím se odstraní další zdroj nekonzistence mezi rozcestníkem a vláknem.

6. Ověření po opravě
- Arturovo vlákno: musí znovu zobrazit původní fotku.
- Seznam vláken: nesmí převzít Arturovu thread stylizaci.
- Jiné vlákno bez vlastní fotky: použije globální `kluci` fotku jen pokud má být součástí globálního vzhledu.
- Vlákno s vlastní fotkou: použije svou fotku a po návratu neprosákne výš.

Soubory k úpravě:
- `src/pages/Chat.tsx`
- `src/components/did/DidKidsThemeEditor.tsx`
- případně drobně `src/contexts/ThemeContext.tsx`, pokud bude potřeba bezpečnější přepnutí persony a obnovení správného základu

Krátký technický závěr:
Bug není v tom, že by se fotka smazala. Bug je v tom, že se Arturovo vlákno teď skládá nad špatnou personou (`default`), protože `kluci` se nepřepnou včas. Oprava tedy musí být: nejdřív načíst globální theme `kluci`, teprve potom přes něj aplikovat thread override.
