
Cíl: Přestat ti dávat neurčité odpovědi a udělat tvrdý audit + jasný plán oprav, aby denní cyklus byl pravdivý, úplný a spolehlivý (včetně mailu ve 14:00).

## 1) Checklist tvých požadavků od rána – stav

### A. Duplicitní záznamy `did_update_cycles` (13.3 + 14.3)
- Stav: ČÁSTEČNĚ SPLNĚNO.
- Dnes v DB je pro 13.3/14.3 vždy 1 daily záznam (duplicitní lavina je pryč).
- Ale problém spolehlivosti běhů trvá (viz níže).

### B. Odstranit lživé části „Jako“ a „Měl“
- Stav: NESPLNĚNO DŮSLEDNĚ.
- V `did_update_cycles.report_summary` stále existují nové běhy s `[KARTA:Jako]` a `[KARTA:Měl]` (14.3 a 15.3).
- V `did_part_registry` a `did_threads` tyto části teď nejsou, ale lživý obsah se stále objevil v denních výstupech.

### C. Přepsat lživé informace na Drive pravdivým obsahem (Arthur)
- Stav: NEDOLOŽENO / NESPOLÉHAT.
- Podle tvé zpětné vazby je `00_Aktualni_Dashboard` stále zcestný.
- Kód nemá tvrdou validaci pravdivosti CENTRUM bloků proti důkazům; spoléhá primárně na prompt AI.

### D. Poctivá redistribuce napříč kartou Arthura (sekce A–M) + 00_CENTRUM
- Stav: ČÁSTEČNĚ SPLNĚNO.
- Je tam mechanika pro sekce A–M a CENTRUM update.
- Ale není zaručeno „vždy vše“: CENTRUM se aktualizuje jen když AI vrátí konkrétní `[CENTRUM:...]` bloky.

### E. Sémantická deduplikace (ne jen textová)
- Stav: ČÁSTEČNĚ SPLNĚNO.
- Je prompt s pravidly sémantické deduplikace + KHASH/substring dedup.
- Chybí tvrdý deterministický semantický validator (embedding/similarity gate) před zápisem.

### F. Sběr „VŠEHO“ za 24h napříč režimy/podrežimy
- Stav: ČÁSTEČNĚ SPLNĚNO.
- Přidáno: `did_threads`, `did_conversations`, `karel_hana_conversations`, `client_sessions`, `crisis_briefs`, `client_tasks`, `research_threads`.
- Chybí další relevantní zdroje (např. DID meetings/některé paměťové vrstvy) pro skutečně „všechno, co se šustlo“.

### G. „Tiché“ načítání profilace terapeutů
- Stav: SPLNĚNO.
- `did_motivation_profiles` se v daily cyklu načítá a injektuje do kontextu.

### H. Automatika 6:00 + 14:00 a správný report
- Stav: NESPLNĚNO SPOLEHLIVĚ.

## 2) Proč dnes (znovu) nedorazil mail ve 14:00 – konkrétní důkaz

1) Cron ve 14:00 (13:00 UTC) je naplánovaný:
- job `did-daily-cycle-14cet`, schedule `0 13 * * *`.

2) Dnes cron SQL proběhl, ale HTTP odpověď funkce byla:
- `net._http_response.id=151`, `status_code=503`,
- obsah: interní runtime service error.

3) Pro dnešní datum není žádný záznam v `did_daily_report_dispatches`:
- tedy mail nebyl odeslán/zaevidován.

4) V kódu je navíc logická kolize:
- daily cyklus má „max 1 completed denně“ cooldown pro cron.
- při existenci dřívějšího completed běhu ten samý den se 14:00 běh přeskočí.
- to je v rozporu s cílem mít pravidelný režim 6:00 i 14:00.

5) Další chyba:
- v „quiet day“ větvi je voláno `HANKA_EMAIL`, ale proměnná není definovaná (je definováno `MAMKA_EMAIL`).
- při klidném dni to může shodit/rozbít část email flow.

## 3) Co je vynechané (hlavní mezery)
- Chybí tvrdá anti-halucinace validace pro CENTRUM výstupy.
- Chybí deterministická sémantická deduplikace (AI prompt nestačí).
- Chybí plná all-source agregace (není skutečně „všechno“).
- Chybí robustní doručení 14:00 reportu při jednorázovém selhání (503) – není retry/fallback.
- Cooldown logika je proti požadované frekvenci 2x denně.

## 4) Implementační plán oprav (co udělám po schválení)

1. Stabilita reportu ve 14:00
- Opravit cooldown na slot-based guard (06:00 slot, 14:00 slot), ne „1x denně“.
- Přidat retry/catch-up pouze pro 14:00 report s deduplikací per recipient+date+slot.
- Opravit `HANKA_EMAIL` bug v quiet-day větvi.
- Přidat tvrdé logování důvodu neodeslání do DB audit tabulky.

2. Antihalucinace a pravdivost
- Zavést validator: každé tvrzení pro kartu/CENTRUM musí mít evidence reference (thread id + message index/role).
- Blokovat zápis tvrzení bez důkazu.
- U existujících jmen mimo registr automaticky reject + audit záznam.

3. Sémantická deduplikace (tvůj požadavek „nosná myšlenka“)
- Přidat předzápisový similarity gate nad cílovou sekcí (význam, ne formulace).
- Pokud je význam stejný, zápis se neprovede; pokud jde o nový detail, doplní se pod existující fakt.

4. Kompletní cross-mode sběr
- Rozšířit agregaci na další perzistentní zdroje relevantní k DID koordinaci.
- Jednotný „evidence bundle“ přes všechny režimy/podrežimy před redistribucí.

5. Tvrdé přepsání 00_CENTRUM při aktualizaci
- Zajistit, že při manuálu i automatu se explicitně obslouží všechny klíčové CENTRUM dokumenty (ne jen když AI vrátí blok).
- Přidat post-write verifikaci obsahu + hash + evidence mapu.

## 5) Akceptační checklist po opravě
- Ve 14:00 vzniknou 2 dispatch řádky (Hanka+Káťa) se `status=sent`.
- Žádné `[KARTA:Jako]`/`[KARTA:Měl]` v nových daily výstupech.
- `00_Aktualni_Dashboard` obsahuje jen tvrzení s dohledatelnou evidencí.
- Manuální „Aktual. kartotéku“ i automat 6/14 aktualizují 00_CENTRUM konzistentně.
- Duplicitní významové zápisy se nevytvářejí ani při jiné formulaci.

