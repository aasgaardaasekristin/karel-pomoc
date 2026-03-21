

# Plan: Oprava Drive architektury — 7 souborů

## Problém
Dokumenty `05_Operativni_Plan` a `06_Strategicky_Vyhled` se přesunuly do podsložky `05_PLAN/` uvnitř `00_CENTRUM`. Dohody jsou nyní v `07_DOHODY/` místo `06_Terapeuticke_Dohody`. Přibyly složky `06_INTERVENCE/` a `09_KNIHOVNA/`. Stávající kód hledá vše flat v `00_CENTRUM` a dokumenty nenajde.

---

## Změny po souborech

### 1. `supabase/functions/karel-did-drive-write/index.ts`

**loadRegistryContext (~line 243-248):**
- Změnit pattern z `^06` + `dohod` na `^07` + `dohod` pro hledání složky dohod

**MODE C — update-therapy-plan (~line 708-710):**
- Místo `findDocumentByPattern(token, centerFolderId, ["05_Terapeuticky_Plan..."])` → nejdřív najít podsložku `05_PLAN` v `centerFolderId`, pak hledat `05_Operativni_Plan` v ní
- Aktualizovat patterny na `["05_Operativni_Plan", "Operativni_Plan"]`

**MODE F — update-strategic-outlook (~line 817-818):**
- Stejný vzor: najít `05_PLAN` podsložku, pak v ní hledat `06_Strategicky_Vyhled`

**Nový MODE G — write-intervention (~line 839):**
- Přijímá `{ mode: "write-intervention", partName, content }`
- Najde složku `06_INTERVENCE` v `centerFolderId`
- Vytvoří nový Google Doc `YYYY-MM-DD_[partName].gdoc`

**Nový MODE H — write-agreement (~line 839):**
- Přijímá `{ mode: "write-agreement", title, content }`
- Najde složku `07_DOHODY` v `centerFolderId`
- Vytvoří nový Google Doc `Dohoda_YYYY-MM-DD_[title].gdoc`

**Error message (~line 843):** přidat nové módy do seznamu

### 2. `supabase/functions/karel-did-morning-brief/index.ts`

**~line 118-136:** Aktuálně hledá `05_Operativni` přímo v CENTRUM souborech.
- Po nalezení `centrumFolder` → najít podsložku `05_PLAN` → v ní hledat `05_Operativni`
- Přidat čtení `DID_Therapist_Tasks` sheetu (export CSV) z CENTRUM pro kontext úkolů

### 3. `supabase/functions/karel-did-context-prime/index.ts`

**~line 627-631:** `readFolderDocs(centrumId, 8)` čte jen flat soubory, přeskakuje podsložky.
- Po stávajícím `readFolderDocs` přidat:
  - Najít `05_PLAN` podsložku → `readFolderDocs` na ni (oba dokumenty)
  - Najít `07_DOHODY` → přečíst poslední 3 soubory (sort by name desc)
  - Najít `06_INTERVENCE` → přečíst posledních 5 souborů
- Uložit do `driveData["PLAN"]`, `driveData["DOHODY"]`, `driveData["INTERVENCE"]`

### 4. `supabase/functions/karel-did-daily-cycle/index.ts`

**~line 2961:** `centrumDocNames` obsahuje staré názvy (`05_Terapeuticky_Plan_Aktualni`).
- Odebrat `05_Operativni_Plan`, `05_Terapeuticky_Plan_Aktualni`, `06_Strategicky_Vyhled` z `centrumDocNames` (ty se najdou v podsložce)
- Po flat loop přidat: najít `05_PLAN` podsložku, přečíst z ní oba dokumenty do `centrumDocsContext`

**~line 2984-3010:** Fallback logika pro dohody.
- Změnit pattern z `terapeutick` + `dohod` na hledání `07_DOHODY` nebo `07` + `dohod`
- Přidat čtení `06_INTERVENCE` podsložky (posledních 5 intervencí)

### 5. `supabase/functions/karel-did-weekly-cycle/index.ts`

**Gather fáze (~line 354-379):**
- Stávající loop přeskakuje složky (kromě `dohod`) → rozšířit:
  - `05_PLAN` → přečíst oba dokumenty jako centrum docs
  - `06_INTERVENCE` → přečíst posledních N souborů
  - `07_DOHODY` nebo pattern `07` + `dohod` → stávající logika
  - `09_KNIHOVNA` → přečíst jako kontext

**Distribute — Strategic (~line 716-724):**
- Hledá `strategick` flat v `centrumFolderId` → najít nejdřív `05_PLAN` podsložku, pak v ní hledat

**Distribute — Operativní plán (~line 795-804):**
- Stejný vzor: hledat v `05_PLAN` podsložce

**Distribute — Dohody (~line 759-782):**
- Změnit název vytvářené složky z `06_Terapeuticke_Dohody` na `07_DOHODY` (~line 769)
- Pattern pro hledání existující složky: `07` + `dohod`

### 6. `supabase/functions/karel-did-centrum-sync/index.ts`

- Dashboard zápis beze změny (flat v CENTRUM ✓)
- Přidat: po zápisu Dashboardu zkusit najít `DID_Therapist_Tasks` sheet v CENTRUM a aktualizovat ho s aktuálními úkoly z DB

### 7. `supabase/functions/karel-chat/systemPrompts.ts`

**ČÁST 15 (~line 71-104):**
- `05_Operativni_Plan (sekce 1)` → `05_PLAN/05_Operativni_Plan (sekce 1)`
- `05_Operativni_Plan sekce 2` → `05_PLAN/05_Operativni_Plan sekce 2`
- `06_Strategicky_Vyhled` → `05_PLAN/06_Strategicky_Vyhled`
- Přidat: zápis intervencí do `06_INTERVENCE/`, dohod do `07_DOHODY/`

**PROVOZNÍ PROTOKOL (~line 222):**
- Aktualizovat strukturu: `00_CENTRUM/ (včetně podsložek 05_PLAN/, 06_INTERVENCE/, 07_DOHODY/, 09_KNIHOVNA/), 01_AKTIVNI_FRAGMENTY/, 02_KLASTRY_A_RODOKMENY/, 03_ARCHIV_SPICICH/, 08_MESICNI_REPORTY/`

**ARCHITEKTURA KARTOTÉKY (~line 234):**
- Přidat zmínku o podsložkách v CENTRUM a `DID_Therapist_Tasks` sheet

---

## Společný vzor (sub-folder lookup)

Všude kde se hledá `05_Operativni_Plan` nebo `06_Strategicky_Vyhled`:

```text
// 1. Najdi podsložku 05_PLAN v CENTRUM
const planFolder = centerFiles.find(f =>
  f.mimeType === DRIVE_FOLDER_MIME &&
  (f.name.includes("05_PLAN") || /^05.*plan/i.test(f.name))
);
// 2. Listuj soubory v ní
if (planFolder) {
  const planFiles = await listFilesInFolder(token, planFolder.id);
  const opFile = planFiles.find(f => f.name.includes("05_Operativni"));
  const stratFile = planFiles.find(f => f.name.includes("06_Strategicky"));
}
```

## Rozsah
7 souborů, všechny edge funkce. Změny jsou na sobě nezávislé — lze implementovat paralelně.

