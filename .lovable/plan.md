

## Diagnóza problému

V resolveru jsou **dva bugy**:

### Bug 1: Filtr na GDOC_MIME při hledání dokumentu
Řádky 136-138 v `karel-drive-queue-processor/index.ts`:
```typescript
const doc = files.find(
  (f) => f.mimeType === GDOC_MIME && f.name.toUpperCase().includes(docName.toUpperCase()),
);
```
Soubory na Drive jsou `PROFIL_OSOBNOSTI.txt` a `SITUACNI_ANALYZA.txt` — to jsou **plain text soubory**, ne Google Docs. Filtr `mimeType === GDOC_MIME` je vyřadí. Stejný bug je i v KARTOTEKA_DID větvi (řádek 114-116).

### Bug 2: appendToDoc používá Google Docs API
`appendToDoc()` volá `docs.googleapis.com/v1/documents/{id}:batchUpdate` — to funguje **pouze** pro Google Docs. Pro `.txt` soubory musí použít Drive API upload (PATCH s media body).

### Bug 3: Shoda názvu zahrnuje příponu
Target je `PROFIL_OSOBNOSTI`, ale soubor na Drive je `PROFIL_OSOBNOSTI.txt`. `includes()` to zvládne, ale jen jedním směrem — toto je OK, není bug.

---

## Plán opravy

### 1. Opravit resolver — odstranit GDOC_MIME filtr
V obou větvích (KARTOTEKA_DID i PAMET_KAREL) nahradit striktní `mimeType === GDOC_MIME` za filtr, který akceptuje Google Docs i textové soubory (vyloučí pouze složky).

### 2. Přidat `appendToFile()` helper do `driveHelpers.ts`
Nová funkce pro append do ne-Google-Docs souborů:
- Stáhne aktuální obsah přes Drive API (`alt=media`)
- Připojí nový text
- Uploadne zpět přes `PATCH` s `uploadType=media`

### 3. Upravit processor aby rozlišil GDOC vs. plain file
Před appendem zjistit mimeType souboru. Pokud je GDOC → použít `appendToDoc()`. Pokud je plain text → použít nový `appendToFile()`.

### Soubory k úpravě
- `supabase/functions/_shared/driveHelpers.ts` — přidat `appendToFile()`
- `supabase/functions/karel-drive-queue-processor/index.ts` — opravit MIME filtr v resolveru + přidat dispatch podle mimeType

Nic dalšího se nemění. Nic se nedeployuje.

