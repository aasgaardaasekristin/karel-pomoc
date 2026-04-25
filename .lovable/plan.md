Plán pro G1.3 — vytvoření přesného dokumentu `05C_SEZENI_LOG`

1. Vytvořit úzkou jednorázovou backend funkci pro dokument-governance úkon
   - Přidám samostatnou funkci typu `karel-create-05c-session-log-doc`.
   - Funkce nebude sahat na `did_pantry_packages` ani `did_pending_drive_writes`.
   - Funkce nebude spouštět pantry flush, drive queue processor, daily-cycle, finalizer, briefing ani dashboard.

2. Přesně resolve cílovou složku
   - Najde root `KARTOTEKA_DID` přes existující Drive helpers.
   - V rootu najde přesně složku `00_CENTRUM`.
   - Pokud složka neexistuje, funkce skončí chybou a nic nevytvoří mimo tento target.

3. Ochrana proti duplicitě a záměně
   - Před vytvořením zkontroluje, zda v `KARTOTEKA_DID/00_CENTRUM/` už existuje soubor s přesným názvem `05C_SEZENI_LOG`.
   - Nebude používat `05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE` jako fallback ani náhradu.
   - Pokud `05C_SEZENI_LOG` už existuje, vrátí jeho file id a nevytvoří duplicitu.

4. Vytvořit Google Docs dokument s přesným obsahem
   - Název: `05C_SEZENI_LOG`
   - Umístění: `KARTOTEKA_DID/00_CENTRUM/`
   - MIME typ: Google Docs dokument.
   - Vloží přesně schválený počáteční text:

```md
# 05C_SEZENI_LOG

Tento dokument je centrální auditní log terapeutických sezení DID systému.

Slouží k lidsky čitelné dokumentaci:
- kdy sezení proběhlo,
- s jakou částí,
- kdo ho vedl,
- v jakém rozsahu proběhlo,
- jaký byl výsledek,
- jaké jsou implikace pro další práci.

Tento dokument není runtime source of truth.
Primární runtime záznamy jsou v databázi, zejména `did_session_reviews`, session plans a související evidence.

Zápisy do tohoto dokumentu musí být dedukční a stručné.
Nepatří sem syrový transcript.
```

5. Ověřit resolver a governance
   - Zavolám/ověřím resolver cestu `KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG` stejným způsobem, jak ji používá drive queue processor.
   - Ověřím, že `documentGovernance.ts` má přesnou whitelist položku `KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG` a žádný wildcard.
   - Bez změny governance, pokud už přesná položka zůstává aktivní.

6. Ověřit databázové bezpečnostní podmínky
   - Zkontroluji, že package `b46379bf-2159-4a60-8f00-14ff7537696d` zůstává `pending_drive`.
   - Zkontroluji, že nevznikl nový row v `did_pending_drive_writes` pro marker `pantry_pkg:b46379bf-2159-4a60-8f00-14ff7537696d` ani target `05C_SEZENI_LOG`.
   - Nezpracuji žádný package ani write.

7. Deploy a spuštění pouze této úzké funkce
   - Deploynu pouze novou úzkou funkci pro vytvoření dokumentu.
   - Spustím pouze tuto funkci.
   - Nebudu deployovat ani spouštět `karel-pantry-flush-to-drive` ani `karel-drive-queue-processor`.

8. Výstup po provedení
   - Vrátím pouze:
     - zda byl dokument vytvořen
     - drive file id
     - přesnou složku/path
     - zda resolver target najde
     - zda governance zůstala přesná
     - zda package `b463...` zůstává pending
     - zda neběžel žádný processor
     - zda je bezpečné následně spustit scoped běh pro `b463...`