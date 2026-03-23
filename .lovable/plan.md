

# Drive sync tracking: unique constraint + unsync indicator

## 1. DB migrace

```sql
ALTER TABLE clients ADD COLUMN IF NOT EXISTS drive_last_synced_at timestamptz DEFAULT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_drive_doc_id_unique UNIQUE (drive_doc_id);
```

## 2. Edge funkce `karel-gdocs-sync`

Po uspesnem zapisu (radek 392, po `writeDocContent`), pridat:
```typescript
const syncedAt = new Date().toISOString();
await supabaseAdmin
  .from("clients")
  .update({ drive_last_synced_at: syncedAt })
  .eq("id", client.id);
```

A do `results.push` pridat `drive_last_synced_at: syncedAt`.

## 3. UI `Kartoteka.tsx`

### Client type (radek 50-66)
Pridat `drive_last_synced_at?: string | null;`

### Helper (pod Client type)
```typescript
// Vraci true, pokud ma klient v DB novejsi zmeny nez posledni Drive sync.
// Pouziva updated_at/created_at z clients a drive_last_synced_at z posledniho karel-gdocs-sync.
const hasUnsyncedChanges = (client: Client): boolean => {
  if (!client.drive_last_synced_at) return true;
  const lastChange = new Date(client.updated_at || client.created_at);
  const lastSync = new Date(client.drive_last_synced_at);
  return lastChange > lastSync;
};
```

### Save button (radky 486-496)
Pridat oranzovou tecku a tooltip kdyz `hasUnsyncedChanges(selectedClient)`:
- `className` na Button: conditionally add orange ring
- Mala oranzova tecka (`<span className="absolute -top-1 -right-1 w-2 h-2 bg-orange-500 rounded-full" />`) uvnitr `relative` wrapperu
- `title` zmenit na "Jsou neulozene zmeny od posledniho syncu" kdyz unsynced

### handleSaveAndBackup (radky 327-332)
Po uspechu take nastavit `drive_last_synced_at` z response:
```typescript
if (result?.docUrl) {
  setSelectedClient(prev => prev ? {
    ...prev,
    drive_doc_id: result.docId,
    drive_doc_url: result.docUrl,
    drive_last_synced_at: result.drive_last_synced_at,
  } : prev);
}
```

### handleBackup (radky 168-171)
Po uspechu `fetchClients()` uz staci — novy sloupec se nacte automaticky.

## Soubory dotcene
- DB migrace (novy SQL)
- `supabase/functions/karel-gdocs-sync/index.ts` (2 radky navic)
- `src/pages/Kartoteka.tsx` (Client type, helper, button UI, state update)

