# OPEN ISSUES

## O-18 — VLAKNA_POSLEDNI conflict: 8.4 append vs. daily-cycle regenerator
> **REKLASIFIKOVÁNO 2026-05-19** — `17fY79Eg43-OYi4-V2rnmndnkdGBiDcqp` je KATA file id, ne HANKA. Skutečná oprava: `VLAKNA_FILE_ID` v admin smoke8-ops přepnut na `1cVD1L7p3LZ32zOZf4w2QzShplozm7AJF`. Forenzní note níže ponechán jako historický záznam.
- **Severity:** high
- **Scope:** 8.5 (write-conflict resolution)
- **Opened:** 2026-05-19
- **Context:** FIX 8.4 enqueue path correctly appends Hana segments to `PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI.txt` via `safeEnqueueDriveWrite` (DB row `completed`, no errors). However `karel-did-context-prime` periodically regenerates/overwrites the same file from conversation history with an explicit "IGNORUJ stávající obsah" instruction, silently discarding 8.4 appends.
- **Evidence:**
  - `did_pending_drive_writes` row `66aa776e…` — status=completed, write_type=append, processed_at=2026-05-19 09:45:09 UTC, no `last_error_message`.
  - Drive file `17fY79Eg43-OYi4-V2rnmndnkdGBiDcqp` revisions show no modification at 09:45 UTC; last write is the bootstrap reset at 05:31 UTC (195 B).
  - Callsite: `supabase/functions/karel-did-context-prime/index.ts` ~line 437 ("IGNORUJ stávající obsah").
- **Impact:** Hana intimate/team segments written via 8.4 to `VLAKNA_POSLEDNI.txt` are not durable on Drive. DB shadow (`hana_personal_memory`) is intact, so no clinical data loss — only Drive surface is stale.
- **Out of scope for 8.4:** 8.4 enqueue path PASS. Resolution belongs to 8.5.
- **Proposed direction (for 8.5 brief):** either (a) gate regenerator to merge append-tail rows from `did_pending_drive_writes`, (b) move VLAKNA_POSLEDNI off the regenerator entirely, or (c) split into separate Drive files per write source.
