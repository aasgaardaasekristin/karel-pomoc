
## FIX 1 — Registry cleanup (plán)

Striktně omezeno na `did_part_registry` + funkci pro lookup. Žádné jiné tabulky se neškrtí.

### Audit současného stavu

- **DB má 67 řádků**, vše pro user_id `8a7816ee-…` (jediný uživatel).
- **Schéma:** `id uuid`, `part_name`, `status`, `index_confirmed_at`, … — **chybí** sloupce `aliases`, `condition`, `source`, `created_by`. (`created_at` existuje.)
- **Lookup logika:** `supabase/functions/_shared/entityRegistry.ts` + `driveRegistry.ts`. Autoritou je Drive `01_INDEX`; DB je jen mirror cache. entityRegistry už dnes **dělá case-insensitive + alias match** (přes `normalize()` v `driveRegistry.ts`). Lookup je tedy „aliasově funkční“ jen tehdy, když Drive 01_INDEX má aliasy — v DB safe-mode (bez Drive) lookup degraduje, protože:
  - entityRegistry selectuje `part_id` (DB má `id`) a `aliases` (sloupec neexistuje) → safe-mode dnes tiše selhává.
- **Cross-table reference**: 42 tabulek odkazuje na `part_name` jako string (mnoho s historickými lowercase variantami `tundrupek`, `arthur`, `gustik`, `001_gerhardt`, `002_Anička`). Žádný FK constraint na `did_part_registry` neexistuje (cross-table je textový, case-sensitive z pohledu equality, ale většina kódu používá normalize/ilike).
- **Quarantined řádky:** `hanička`, `KAREL`, `karel`, `káťa` mají status `quarantined_wrong_identity_*` — nejsou v kanonickém seznamu, ale jsou to záměrné guardrails (P32/P33_5h).

### Otevřené rozhodnutí, na které potřebuju potvrzení

Před spuštěním migrace potřebuji **explicitní souhlas** se třemi rozsahovými body — nejsou jednoznačné v briefu:

1. **Quarantined řádky (`hanička`, `KAREL`, `karel`, `káťa`)** — brief říká „39 řádků přesně“ a zároveň „nepřepisuj historii“. Tyto 4 řádky **nejsou** duplicity ani bulk-import; jsou to záměrné guardrails. Návrh: **NECHAT je v DB**, ale vyloučit z čítače „kanonických 39“. Finální stav: 39 kanonických + 4 quarantined = **43 řádků celkem**. (Self-audit `COUNT(*)=39` upravím na `COUNT(*) WHERE status NOT LIKE 'quarantined%' = 39`.) Pokud chceš striktně 39 řádků a smazat quarantined, řekni — ale tím rozbiju P32/P33_5h identity guard.
2. **Cross-table přejmenování**: kanonický seznam má `Tundrupek` (mixed case), DB má historické `tundrupek` a UPPERCASE `TUNDRUPEK`. V jiných tabulkách (`did_threads`, `crisis_events`, …) existují řádky s `part_name='tundrupek'` i `'TUNDRUPEK'`. Návrh: **necháme cross-table data být** (brief zakazuje sahat na jiné tabulky); v `did_part_registry` ponecháme kanonickou formu z briefu (`Tundrupek`) a spoléháme na case-insensitive lookup v aplikační vrstvě. To je v souladu s briefem bodem 6 (case-insensitive lookup).
3. **„Bulk import 2026-03-24“ pravidlo + Petřík/Petříček/Péťa Kyblík**: tito mají původní řádek z **2026-03-24** (lowercase mixed) a UPPERCASE duplikát z **2026-04-07**. Brief říká „smaž ten 2026-03-24 NEBO UPPERCASE“ — u těchto je „originál“ z 2026-03-24 a UPPERCASE z 04-07. Návrh: smažu UPPERCASE duplikát (zachovat historicky starší mixed-case řádek), jak velí druhá podmínka briefu („má historii, mixed case“).

### Plánované změny

#### A. Migrace schématu (jediná tabulka `did_part_registry`)

```sql
-- 1) Backup
CREATE TABLE did_part_registry_backup_2026_05_16 AS
SELECT * FROM did_part_registry;

-- 2) Nové sloupce (idempotentně)
ALTER TABLE did_part_registry
  ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT;

-- 3) Index pro case-insensitive lookup
CREATE INDEX IF NOT EXISTS did_part_registry_lower_name_idx
  ON did_part_registry (user_id, lower(part_name));
CREATE INDEX IF NOT EXISTS did_part_registry_aliases_gin_idx
  ON did_part_registry USING gin (aliases);
```

Status doménu (`active`, `active_partial`, `sleeping`) **nepřidávám jako enum** — sloupec je `text`, zůstává textový.

#### B. Datová cleanup transakce (BEGIN/COMMIT, single statement batch)

1. **Smazat 28 řádků** podle priority (přesný seznam vygeneruji a vypíšu PŘED commitem):
   - Všechny UPPERCASE řádky z 2026-03-24, které mají lowercase/mixed-case párovaný řádek (Anička, Tundrupek, Bélo, Gustík, Arthur, Karel, Bendík, Wolf, Mikolko, Henrik, Lobzhang, Dmytri, Christoffer, Petr_Reka, Jonir, Tenzing, Einar, Gunnar, Adam, Zuzanka, Barunka, Tundrup_Puvodni, Gustav_Puvodni, Gerhardt, Vasil, Sergej, Janeček, Ondrášek, Oskar, Kája, Sigurd, Vítek15, Vítek16, Gabriel1, Gabriel2 …) — UPPERCASE jdou pryč, mixed-case zůstávají.
   - Sloučené záznamy jako `Tenzing/Christofer`, `CLARK, KLARK`, `GABRIEL 1 - GEJBÍ`, `JÓNAS - Jonášek`, `SERGEJ - voják`, `BÉLLO`, `TUNDRUP - Původní část`, `BENDIK_BONDEVIK`, `Bendík`, `GABRIEL` (generický), `Dokument bez názvu` → smazat (nejsou v kanonickém seznamu nebo jsou nekanonické formy).
   - `001_gerhardt`, `002_Anička` → přejmenovat na `Gerhardt` / `Anička` (zachovat řádek s historií, ne mazat).

2. **UPSERT 39 kanonických řádků** přesně podle tabulky:
   - `part_name`, `status`, `aliases`, `condition` nastaveny dle briefu.
   - Gustík: `condition='částečně aktivní - DID část usíná, vyžaduje pozornost'`, ostatní `NULL`.
   - `Gustav_Puvodni_Cast`: **bez aliasu „Karel“** (dle explicitní poznámky briefu — to je AI asistent).
   - `Tundrupek`, `Arthur`: `status='active'`. `Gustík`: `status='active_partial'`. Zbytek: `sleeping`.
   - Retrospektivně: pro řádky, které měly historii před 03-24 → `source='manual'`, `created_by='kristin'`. Nově upsertované kanonické formy (které dříve existovaly jen UPPERCASE) → `source='manual'`, `created_by='kristin'` (existují, jen byly v UPPERCASE od Karla).
   - Pro **dosud smazané UPPERCASE bulk řádky** vědomě nezakládám nový retrospektivní `karel` záznam (smazaly se).

3. **Quarantined řádky** (`hanička`, `KAREL`, `karel`, `káťa`): NETKÁM se jich. Necháme tam.

4. **Log před commitem** vypíše: počet smazaných řádků, počet upravených, počet upsertovaných, finální count.

#### C. Oprava lookup funkce

Místo zavedení nové SQL `lookup_part(text)` opravím existující TS vrstvu (autorita = Drive 01_INDEX, DB = mirror) tak, aby **DB safe-mode skutečně fungoval**:

- `supabase/functions/_shared/entityRegistry.ts`:
  - Změnit select z `part_id, part_name, aliases, status, index_confirmed_at` → `id, part_name, aliases, status, index_confirmed_at` (sloupec se jmenuje `id`, ne `part_id`).
  - `row.part_id` → `row.id`.
  - `stampIndexConfirmation`: `.eq("part_id", …)` → `.eq("id", …)`.
- `driveRegistry.ts.normalize()` už dělá NFD + lower + strip non-alphanum, takže case-insensitive + diacritic-insensitive match je hotov. Aliasový lookup po cleanup začne fungovat i v safe-mode, protože DB bude mít `aliases TEXT[]` naplněné.
- Žádný nový SQL helper, žádná nová RPC.

#### D. Self-audit po commitu (přesně podle briefu, s úpravou bodu 1 a 4 kvůli quarantined)

```sql
-- Kanonické (mimo quarantined)
SELECT COUNT(*) FROM did_part_registry
  WHERE status NOT LIKE 'quarantined%';                -- musí být 39
SELECT COUNT(*) FROM did_part_registry WHERE status='active';          -- 2
SELECT COUNT(*) FROM did_part_registry WHERE status='active_partial';  -- 1
SELECT COUNT(*) FROM did_part_registry WHERE status='sleeping';        -- 36
SELECT COUNT(*) FROM did_part_registry WHERE condition IS NOT NULL;    -- 1 (Gustík)
SELECT part_name,status FROM did_part_registry WHERE part_name ILIKE 'an%' AND status NOT LIKE 'quarantined%';
SELECT COUNT(*) FROM did_part_registry_backup_2026_05_16;              -- 67
```

Plus TS smoke test: `entityRegistry.lookupByName('tundrupek') == lookupByName('TUNDRUPEK')`, `lookupByName('ARTUR').canonicalName == 'Arthur'`, `lookupByName('GERŤA').canonicalName == 'Gerhardt'` — přidám jako vitest do `src/test/`.

### Návrhy nad rámec (NEIMPLEMENTUJI bez separátního příkazu)

- Sync `01_INDEX` Drive sheet s kanonickými 39 + aliasy (Drive je autorita, jinak při příštím Drive fetch DB rebuild přepíše část naší práce).
- Vyčistit historické UPPERCASE `part_name` hodnoty v cross-tabulkách (43 tabulek).
- DB enum pro `status`.
- Smazání quarantined řádků (vyžaduje review P32/P33_5h guardu).

### Deliverable

1 schema migrace + 1 data migrace (BEGIN/COMMIT s pre-commit logem) + 1 patch v `entityRegistry.ts` + 1 vitest. Po dokončení nahlas přesně dle bodů 1–4 briefu.

**Před spuštěním potřebuju potvrzení na 3 otevřená rozhodnutí výše (zejména bod 1 — quarantined řádky).**
