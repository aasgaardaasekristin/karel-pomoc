
Cílem je napravit důvěru: udělám znovu celý E2E test přesně podle tvé instrukce a tentokrát s auditní stopou (krok → důkaz → výsledek), bez tvrzení „hotovo“ bez dat.

1) Co jsem si ověřil předem (aktuální stav)
- Jsi přihlášený v preview a v DID terapeutickém dashboardu.
- `did_therapist_tasks` je teď prázdná (proto jsi nic neviděl na nástěnce).
- UI logika sekcí je v kódu správně:
  - DNES max 5
  - ZÍTRA max 5
  - Dlouhodobé max 10 (pasivní list)
- Chat inline návrhy `[TASK_SUGGEST:assignee:category]...` jsou zapojené a ukládají úkol do `did_therapist_tasks`.
- Archivace „po 3 dnech“ je frontend lifecycle při načtení nástěnky (smazání dokončených úkolů starších než 3 dny).

2) Upřesnění testu (potvrzeno)
- Archivaci ověřím simulací 3 dnů backdatem (`completed_at` posunu o 4 dny).
- Po testu provedu kompletní cleanup testovacích dat.

3) Přesný testovací scénář (co provedu krok za krokem)
A. DID dashboard + Karlův přehled
- Otevřu DID režim terapeut.
- Kliknu „Obnovit“ u Karlova přehledu.
- Zkontroluji, že případné nové úkoly jsou rozdělené do DNES/ZÍTRA/Dlouhodobé.
- Důkaz: screenshot + DB snapshot `did_therapist_tasks` (category, assigned_to, statusy).

B. Ruční test úkolu + splnění + archivace 3 dny
- Přidám testovací úkol s unikátním markerem (např. `TEST_E2E_<timestamp>`).
- Označím obě semafory na zelenou (H + K), ověřím `status=done` a `completed_at`.
- Provedu backdate `completed_at` o 4 dny.
- Obnovím nástěnku (trigger load) a ověřím automatické odstranění.
- Důkaz: before/after DB + screenshot před/po.

C. Chat Káťa: inline návrh úkolu
- Otevřu režim Káťa (PIN), zahájím vlákno.
- Vynutím dohodu tak, aby Karel navrhl zápis úkolu (čekám na `[TASK_SUGGEST:...:today|tomorrow]`).
- Kliknu inline „Zapsat“.
- Ověřím, že úkol je v nástěnce v odpovídající sekci.
- Důkaz: screenshot zprávy s tlačítkem + DB řádek + screenshot nástěnky.

D. Chat Hanička: dlouhodobý neaktivní list
- Otevřu režim Hanička (PIN), zahájím vlákno.
- Vynutím dohodu na dlouhodobém úkolu (`category=longterm`).
- Kliknu inline „Zapsat“.
- Ověřím, že úkol je v sekci Dlouhodobé jako pasivní list (ne traffic karta).
- Důkaz: screenshot + DB.

E. Zkušební aktualizace kartotéky
- Spustím „Aktualizovat kartotéku“ (denní cyklus).
- Ověřím výstup cyklu (`did_update_cycles.cards_updated`) a že úkolové informace byly promítnuty do správných existujících dokumentů.
- Důkaz: `cards_updated` + obsahové diffy dokumentů (před/po).

F. Kontrola „NIKDY samostatný dokument“
- Udělám inventory souborů před/po v relevantních složkách kartotéky (ID+name).
- Potvrdím, že nevznikl nový standalone dokument pro testovací úkoly.
- Pokud by vznikl, nahlásím přesný název/ID a odstranění.
- Důkaz: before/after seznam souborů + explicitní verdikt.

G. Cleanup
- Smažu testovací úkoly z `did_therapist_tasks` (marker).
- Odstraním testovací textové zápisy z dokumentů (jen test marker bloky).
- Znovu ověřím čistý stav.

4) Co ti pak předám (finální report)
- Přesný seznam dokumentů a sekcí, kam se testovací úkoly propsaly.
- Přesné řádky/odstavce s test markerem.
- Seznam všeho, co bylo po testu smazáno (UI + dokumenty).
- Jasné „PASS/FAIL“ pro:
  1) rozdělení DNES/ZÍTRA/Dlouhodobé
  2) archivace po 3 dnech (simulace)
  3) inline task nabídka Káťa
  4) inline longterm nabídka Hanička
  5) žádné standalone dokumenty.

Technické detaily (důležité)
- Archivace 3 dny je aktuálně implementovaná v UI komponentě nástěnky při `loadTasks()`; proto test potřebuje reload/refresh trigger po backdate.
- Deduplikace je dvouvrstvá:
  - z Karlova přehledu přes normalizovaný hash text+řešitel,
  - z inline tlačítka přes podobnost textu (ilike).
- Kontrola „žádný standalone dokument“ bude opřená o porovnání inventáře souborů před/po, ne jen o textové tvrzení.
- Známá neblokující chyba v konzoli: `DidSystemMap` má vnořené `<button>` (DOM nesting warning) + ref warning; netýká se přímo task flow, ale doporučuji následně opravit.
