

## Plan: Fix diacritic inconsistency in subsection keys

### Problem
`povedomí_o_systemu_a_role` (with diacritic `í`) is used in `sectionAUpdater.ts` and `threadAnalyzer.ts`, but the edge function `karel-thread-analyzer` uses `povedomi_o_systemu_a_role` (without diacritics). This causes AI-generated updates to fail matching.

### Changes

**File 1: `src/services/cardUpdaters/sectionAUpdater.ts`**
Replace all 10 occurrences of `povedomí_o_systemu_a_role` → `povedomi_o_systemu_a_role` (interface, defaults, parser return, rebuild, and update application).

**File 2: `src/services/threadAnalyzer.ts`** (line 93)
Replace `povedomí_o_systemu_a_role` → `povedomi_o_systemu_a_role` in the prompt constant.

### Other diacritic keys found (consistent, no mismatch)
- `TERAPEUTICKÝ_PROFIL` — used consistently in `karel-did-part-summary` and `DidPartCard.tsx`
- `SPLNĚNÍ_HANKA`, `SPLNĚNÍ_KATA`, `HODNOCENÍ_TÝMU`, `NESPLNĚNÉ_3+_DNÍ`, `POZVÁNKA_NA_PORADU` — prompt-internal labels in `karel-did-daily-cycle`
- `ZVÝŠENÁ_AKTIVITA`, `VYSOKÁ_AKTIVITA` — local string comparisons in `karel-did-context-prime`
- `POSLEDNÍ_AKTUALIZACE` — sheet header in `karel-did-drive-write`

These are all internally consistent (no mismatch between files), but per your rule they should also be ASCII-only. Changing them would require updating both the edge functions and the components that parse those keys. I can include those fixes now or defer them — let me know.

### Summary
- 2 files changed, ~10 replacements total for the critical fix
- No database or edge function changes needed (the edge function already uses the correct ASCII version)

