
Cíl: opravit skutečnou příčinu zasekávání týdenní analýzy a zároveň odstranit samovolné „vyskočení“ z vnořeného DID rozhraní.

1. Co je teď skutečně špatně
- Týdenní cyklus není zaseklý v UI, ale v backendové fázi `gathering`, proto panel visí na 15 %.
- Aktuální záznam v databázi je stále `running` a je ve fázi `gathering` s detailem `Hledám nové výzkumy (Perplexity)...`.
- Logy ukazují, že před tím už selhává čtení některých Drive souborů a pak runtime funkci ukončí (`shutdown`) dřív, než stihne zapsat `gathered` nebo `failed`.
- To znamená: současná „5fázová“ architektura je pořád příliš hrubá, protože celá fáze `gather` je ještě pořád jeden dlouhý monolit.

2. Hlavní technická příčina
- `phaseGather()` dělá v jednom requestu příliš mnoho:
  - prochází složky na Drive rekurzivně,
  - čte desítky souborů postupně,
  - skládá velký kontext,
  - pak teprve volá Perplexity.
- Když se timeout nebo shutdown stane uvnitř `gather`, kód se už nedostane do bezpečného dokončení a záznam zůstane `running`.
- Navíc se špatně používá `started_at`:
  - přepisuje se jako heartbeat,
  - takže se míchá „čas spuštění cyklu“ a „poslední aktivita“.
- V kódu je vidět i další signál problému: `MIN_BUDGET_FOR_PERPLEXITY_MS` existuje, ale reálně se nepoužívá, takže Perplexity se spustí i tehdy, když už na něj skoro nezbývá čas.

3. Druhý samostatný problém: samovolné vyskakování zanoření
- Mobilní swipe-back je globální a kliká na první nalezený `[data-swipe-back='true']` v DOM.
- To je křehké: gesto není navázané na konkrétní aktivní vrstvu, ale na „první zpět tlačítko, které zrovna existuje“.
- Proto může při dotyku od levého okraje skočit o úroveň výš, i když uživatel chtěl jen scrollovat nebo zůstat v terapeutickém dashboardu.
- Současný lock je jen lokální na `DidAgreementsPanel`, ne na celé DID dashboard vrstvě během běžícího cyklu.

4. Funkční řešení, které bych implementoval
- Rozdělit `gather` na malé resumable kroky s perzistovaným stavem:
  - `gather:discover`
  - `gather:cards-active`
  - `gather:cards-archive`
  - `gather:centrum`
  - `gather:db`
  - `gather:research`
  - `gather:perplexity`
- Po každém malém kroku uložit do `context_data`:
  - co už je hotovo,
  - cursor/index další várky,
  - průběžný heartbeat,
  - průběžný progress.
- Jeden request smí zpracovat jen omezený počet souborů, např. 3–8 souborů nebo 1 subkrok.
- Frontend bude stále volat `gather`, ale backend vždy naváže přesně tam, kde skončil, místo aby začínal celý sběr znovu.
- Perplexity bude:
  - až úplně na konci gather,
  - pouze pokud zbývá dost času,
  - jinak se odloží do dalšího requestu.

5. Co změnit v datech a stavu cyklu
- Přestat používat `started_at` jako heartbeat.
- Přidat samostatná pole:
  - `heartbeat_at`
  - `phase_started_at`
  - `progress_current`
  - `progress_total`
  - `phase_step`
  - `last_error`
- Stale watchdog musí kontrolovat `heartbeat_at`, ne `started_at`.
- Při tvrdém timeoutu pak další request nebo watchdog bezpečně pozná, kde přesně pokračovat.

6. Co změnit v UI
- V `DidAgreementsPanel` neukazovat fixních 15 % pro celý gather.
- Zobrazit skutečný průběh sběru:
  - např. „Načteno 7/23 karet“
  - „Centrum 2/5 dokumentů“
  - „Research hotovo“
  - „Perplexity čeká / běží“
- Polling musí být podle konkrétního `cycleId` a zobrazovat heartbeat i substep.
- Pokud heartbeat stojí déle než limit, UI nemá jen točit kolečko, ale ukázat „cyklus uvízl v kroku X“ a nabídnout bezpečné pokračování.

7. Jak opravit samovolný návrat o úroveň výš
- Zrušit globální `querySelector("[data-swipe-back='true']")`.
- Swipe-back musí být navázané na aktivní view, ne na první tlačítko v dokumentu.
- Nejbezpečnější varianta:
  - swipe-back řešit přes callback z aktuální obrazovky,
  - nebo přes scoped container s vlastním targetem.
- Během běžícího týdenního cyklu swipe-back pro celý DID dashboard vypnout, ne jen pro panel.
- Zároveň opravit i neplatné vnoření `button` v `DidAgreementsPanel`, protože to může dělat podivné click/chování v interakci.

8. Proč si myslím, že tohle je skutečná oprava
- Logy jednoznačně ukazují backendový problém ve `gather`.
- Databáze potvrzuje, že cyklus je stále ve `gathering`, ne v `analyze` ani `distribute`.
- Samovolné vyskočení je druhá chyba v navigaci/gestu, ale není primární příčina 15 %; spíš maskuje problém a zhoršuje UX.
- Skutečně stabilní řešení je tedy dvojité:
  - backend: resumable gather s heartbeatem,
  - frontend: scoped swipe-back + lock na celé aktivní DID vrstvě.

9. Implementační plán
- Audit a refaktor `karel-did-weekly-cycle` tak, aby `gather` běžel po dávkách a ukládal cursor.
- Přidat heartbeat/progress sloupce do tabulky cyklů.
- Upravit watchdog cleanup podle `heartbeat_at`.
- Upravit `DidAgreementsPanel` na substep progress a resume logiku po dávkách.
- Přepsat `MobileSwipeBack` na scoped gesture a během běhu cyklu ho na DID dashboardu zablokovat.
- Opravit invalidní nested button v `DidAgreementsPanel`.

Technické poznámky
- Aktuální problémový běh: weekly cycle je teď `running` ve fázi `gathering`.
- V logu je vidět timeout při čtení Drive souboru a následně shutdown po kroku Perplexity.
- `phaseGather()` je dnes stále příliš velký blok.
- `MIN_BUDGET_FOR_PERPLEXITY_MS` je v kódu definované, ale nepoužité.
- `started_at` se teď chová jako heartbeat, což komplikuje detekci skutečně zaseklého běhu.
