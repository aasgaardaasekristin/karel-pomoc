

# Fix deploy blocker v `karel-did-daily-cycle/index.ts`

## Příčina
Soubor `supabase/functions/karel-did-daily-cycle/index.ts` obsahuje dva `npm:` importy nekompatibilní s edge function bundlerem:
- řádek 3: `import { Resend } from "npm:resend@2.0.0";`
- řádek 4: `import * as XLSX from "npm:xlsx@0.18.5";`

## Plán (2 změny, 1 soubor)

1. **Řádek 3**: `npm:resend@2.0.0` → `https://esm.sh/resend@2.0.0`
2. **Řádek 4**: `npm:xlsx@0.18.5` → `https://esm.sh/xlsx@0.18.5`

Nic jiného se nemění. Po opravě deploy celého edge function bundlu projde.

## Ověření
- Po změně deploy `karel-did-daily-cycle`
- Zkontrolovat, že žádný další `npm:` import neexistuje v jiných edge functions

