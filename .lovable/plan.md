
Cíl: okamžitě doručit to, co mělo už fungovat — rozpoznání části při vstupu do vlákna podle registru v databázi i podle Excel registru na Drive, následné sjednocení na kanonické jméno a teprve potom načtení správné karty do lokální kontextové paměti.

Co jsem ověřil
- `DidPartIdentifier.tsx` dnes dělá jen primitivní lokální porovnání přes `includes()` nad `knownParts`. Excel na Drive vůbec nekontroluje.
- `karel-did-part-detect/index.ts` kontroluje pouze `did_part_registry`. Drive Excel nekontroluje.
- `karel-did-system-overview/index.ts` má jen natvrdo aliasy pro `dmytri`; obecná aliasová logika pro `Arthur = Artur` neexistuje.
- V kódu už existuje čtení Excel registru z Drive:
  - `karel-did-daily-cycle/index.ts` umí načíst registry sheet (`readRegistryRows`, `loadRegistryContext`, `findBestRegistryEntry`)
  - `karel-did-drive-write/index.ts` umí totéž
- Tedy: potřebná logika pro Excel existuje, ale není napojená do live detekce částí.
- V databázi je potvrzená duplicita:
  - `arthur / ARTHUR`
  - `artur / artur`

Proč to teď selhává
1. Vstup „Jak ti říkají?“ nevolá centrální detekci identity.
2. Centrální detekce identity nečte Drive registr.
3. Vlákno se vytvoří ještě před plnou kanonizací identity.
4. Přehled pak bere názvy z vláken a neumí je vždy sloučit.
5. Načtení karty používá `Karta_${safePartName}`, takže pokud je kanonické jméno špatně, natáhne se špatný nebo žádný kontext.

Implementační plán
1. Zavedu jednotný resolver identity části
- Vytvořit jednu sdílenou serverovou logiku pro:
  - normalizaci jmen
  - fuzzy matching
  - porovnání s DB registrem
  - porovnání s Excel registrem na Drive
  - výběr kanonického jména
- Resolver bude vracet:
  - `matched`
  - `canonicalPartName`
  - `displayName`
  - `source` (`db`, `drive`, `both`, `new`)
  - `aliasesMatched`
  - `registry/profile/card` metadata

2. Napojit live vstup „Jak ti říkají?“ na resolver
- `DidPartIdentifier.tsx` přestane rozhodovat lokálně.
- Po Enter/kliknutí zavolá `karel-did-part-detect`.
- Teprve výsledek resolveru rozhodne:
  - pod jakým `part_name` se vlákno uloží
  - jaký `thread_label` zůstane jako alias
  - jaká karta se natáhne do kontextu

3. Rozšířit `karel-did-part-detect` o Drive Excel
- Reuse existující registry parsování z daily-cycle/drive-write.
- Pořadí rozhodování:
  1. DB exact / alias / fuzzy
  2. Drive Excel exact / alias / fuzzy
  3. sloučení obou zdrojů do jedné kandidátní množiny
  4. pokud shoda dost silná, vrátit kanonickou část
  5. pokud není, označit jako novou / neověřenou část
- Přidat robustnější scoring:
  - exact
  - bez diakritiky
  - prefix/id match
  - edit distance / podobnost pro `artur ↔ arthur`
  - podpora aliasů z registru a z `display_name`

4. Opravit tvorbu vláken a načítání kontextu
- `Chat.tsx` bude při vytvoření vlákna vždy ukládat kanonické `part_name`.
- `thread_label` zůstane jméno, kterým se část představila.
- Následné čtení karty z Drive poběží už nad kanonickým jménem, ne nad raw vstupem.
- Tím se splní požadavek: detekce identity → načtení správné karty → lokální kontext → adekvátní komunikace.

5. Opravit přehled a další agregace
- `karel-did-system-overview` nahradí hardcoded aliasy obecným resolverem.
- Přehled přestane rozdělovat `ARTHUR`, `artur`, `Arthur` do více entit.
- Stejný resolver použít i tam, kde se z vláken generují souhrny, audity a denní maily.

6. Vyčistit už vzniklou nekonzistenci v datech
- Sloučit duplicitní registry záznamy `artur -> arthur` / finální kanonický tvar podle zvoleného standardu.
- Přemapovat existující data:
  - `did_threads`
  - `did_part_sessions`
  - `did_part_profiles`
  - případně další DID tabulky s `part_name`
- Nejde jen o UI chybu; je nutné opravit i historická data, jinak se chyba bude vracet v přehledech a analýzách.

7. Zabránit opakování chyby
- Zavést pravidlo: žádné nové cast vlákno bez serverové detekce identity.
- Přidat ochranu při insert/update registru:
  - varování při blízké duplicitě
  - možnost aliasu místo nové části
- Přidat audit log, z jakého zdroje byla identita rozpoznána (DB / Drive / fuzzy / nová část).

Soubory k úpravě
- `src/components/did/DidPartIdentifier.tsx`
- `src/pages/Chat.tsx`
- `supabase/functions/karel-did-part-detect/index.ts`
- `supabase/functions/karel-did-system-overview/index.ts`
- sdílená Drive registry utilita v `supabase/functions/_shared/...`
- datová oprava existujících záznamů v DID tabulkách

Důležitá architektonická změna
- Excel na Drive nebude jen „někde bokem“ pro dávkové cykly.
- Stane se součástí online rozhodovací vrstvy pro identitu části.
- DB registr zůstane rychlá operativní vrstva, Drive Excel bude autoritativní kontrolní zdroj pro aliasy, ID a kartu.

Výsledek po úpravě
- `Artur`, `Arthur`, `artur`, případně další aliasy se sjednotí na jednu část.
- Vlákno se povede pod správnou částí.
- Karel natáhne správnou kartu do lokální kontextové paměti.
- Přehled, denní maily i další DID analýzy přestanou duplikovat stejné části pod různými jmény.
- Chyba nebude jen maskovaná v přehledu, ale opraví se v samotném vstupním bodu systému.

Pořadí implementace
1. Kritické: live detekce přes DB + Drive v `karel-did-part-detect`
2. Kritické: přepojení `DidPartIdentifier` a `Chat.tsx` na kanonické jméno
3. Kritické: datové sloučení existujících duplicit
4. Vysoká priorita: sjednocení overview a dalších agregací na stejný resolver
5. Následně: prevence duplicit a audit zdroje rozpoznání
