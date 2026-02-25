
Cíl:
- Opravit 3 problémy v audio UX:
  1) vysvětlit a přidat smysluplný progress bar nahrávání,
  2) zpřístupnit/odblokovat tlačítko „Analyzovat“ (aby bylo vždy viditelné a klikatelné),
  3) zabránit tomu, aby po spuštění nahrávání mizelo textové chatovací pole.

Co je „progress bar nahrávání“ (srozumitelně):
- Je to vizuální ukazatel, kolik z maximální délky nahrávky už je využito.
- V tomto projektu je limit 5 minut (300 s), takže lišta ukáže průběh 0 → 100 %.
- Prakticky: uživatel hned vidí, kolik času zbývá, a není překvapen automatickým zastavením.

Zjištěná příčina v aktuálním kódu:
- Input oblast je v obou místech (`src/pages/Chat.tsx`, `src/components/report/SupervisionChat.tsx`) postavená jako jeden horizontální flex řádek s mnoha prvky.
- `AudioRecordButton` při stavech `recording`/`recorded` výrazně změní šířku (čas + stop, pak audio přehrávač + zahodit + analyzovat), což při menším prostoru vytlačí `Textarea`.
- Výsledek: pole pro psaní se „ztratí“ (reálně se zkolabuje/odteče), a tlačítko „Analyzovat“ se může ocitnout mimo viditelnou oblast nebo působit neaktivně.

Implementační postup:

1) Stabilizace layoutu vstupu (hlavní oprava mizícího chatovacího okna)
- Soubor: `src/pages/Chat.tsx`
- Soubor: `src/components/report/SupervisionChat.tsx`
- Změna:
  - Přestavět spodní input část na 2 řádky:
    - Řádek A: obrázek + textové pole + odeslat.
    - Řádek B: akční tlačítka (audio + studijní materiál / pořídit zápis).
  - Přidat `min-w-0` + `flex-1` na kontejner textového pole, aby se nesložil při změně šířky ostatních prvků.
  - Povolit zalomení (`flex-wrap`) u sekundárních akcí, aby nic neodjelo mimo viewport.
- Očekávaný efekt:
  - Textarea zůstane viditelná při všech audio stavech.
  - „Analyzovat“ bude dostupné i na menších šířkách.

2) Úprava `AudioRecordButton` pro lepší dostupnost „Nahrát“ a „Analyzovat“
- Soubor: `src/components/AudioRecordButton.tsx`
- Změna:
  - Zachovat konzistentní (predikovatelnější) šířku komponenty napříč stavy.
  - V recorded stavu zmenšit horizontální náročnost (responsivní chování + wrap), aby tlačítko „Analyzovat“ nebylo schované.
  - Přidat jasnější textové labely akcí (např. „Nahrát“, „Zastavit“, „Analyzovat“), nejen ikony.
  - Ošetřit disabled stav konzistentně i pro relevantní akce.
- Očekávaný efekt:
  - Uživatel vždy jasně vidí, co je další krok.
  - Nižší riziko, že tlačítko „Analyzovat“ bude mimo obraz.

3) Progress bar + časový kontext nahrávání
- Soubor: `src/components/AudioRecordButton.tsx`
- Soubor: `src/hooks/useAudioRecorder.ts`
- Změna:
  - Využít existující `src/components/ui/progress.tsx`.
  - Zobrazit v `recording` stavu:
    - elapsed čas,
    - progress bar (z 300 s),
    - případně stručný text „zbývá X:YY“.
  - V hooku explicitně exportovat/vracet max limit (300 s), aby UI nepoužívalo hardcoded duplicitu.
- Očekávaný efekt:
  - Uživatel ví, kolik času má.
  - Přirozenější UX při automatickém stopu po 5 minutách.

4) Zpřístupnění audio analýzy v praxi (interakční tok)
- Soubor: `src/pages/Chat.tsx`
- Soubor: `src/components/report/SupervisionChat.tsx`
- Změna:
  - Ujistit se, že přechod `recording -> recorded` je v UI jednoznačný a akce „Analyzovat“ je viditelná bez horizontálního scrollu.
  - Po odeslání analýzy zachovat stávající kontextový behavior (mode + chat context), jen zlepšit ovladatelnost.
- Očekávaný efekt:
  - Funkční tok: Nahrát -> Zastavit -> Analyzovat -> výsledek v chatu.

Testovací scénáře (end-to-end):
1. `/chat` v režimech: Supervizní reflexe, Bezpečnost a hranice, Péče o dítě, Debrief:
   - Spustit nahrávání, během nahrávání zkontrolovat, že textarea nezmizí.
   - Zastavit, ověřit viditelné a klikatelné „Analyzovat“.
2. Report split-view (`mainMode = report`, komponenta `SupervisionChat`):
   - Totéž na užším viewportu (mobil/tablet/desktop).
3. Limit 5 minut:
   - Ověřit progress bar a auto-stop + toast.
4. Chybové stavy:
   - Zakázaný mikrofon -> toast chyba, UI se nerozbije.
5. Síť:
   - Po kliknutí „Analyzovat“ ověřit request na `karel-audio-analysis` a vrácení odpovědi do chatu.

Poznámka k backendu:
- Není potřeba měnit databázi ani přístupová pravidla.
- Funkce `karel-audio-analysis` už obsahuje kontextové větvení podle režimu; zde jde hlavně o UI/UX zpřístupnění akce.

Rizika a mitigace:
- Riziko: příliš mnoho tlačítek v jednom řádku na malých displejích.
  - Mitigace: dvouřádkový layout + wrap + `min-w-0`.
- Riziko: nejednotné chování mezi `/chat` a report split-view.
  - Mitigace: aplikovat stejný layout pattern v obou souborech a otestovat oba flow.

Po schválení provedu přesně tyto úpravy v uvedených souborech.
