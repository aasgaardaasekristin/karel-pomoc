

# Phase 2.6 — Identity Resolution & Entity Governance

## Current State Summary

After reading all relevant files, the actual codebase confirms:
- **`thread-sorter`**: Per-segment AI processing IS implemented (line 469 loop). Entity guardrails use hardcoded `CONFIRMED_PARTS` (25 entries), `ALIAS_MAP` (2 entries), `NON_PART_ENTITIES` (2 entries), and `EXPLICITLY_UNCERTAIN` (1 entry) — all static.
- **`topicSegmentation.ts`**: Hardcoded `KNOWN_PARTS` array (line 99–104) and part names baked into `PART_CLINICAL_KW` (lines 67–71).
- **`signalNormalization.ts`**: Separate hardcoded `KNOWN_PARTS` array (lines 122–127).
- **`reactive-loop`**: Hardcoded `DID_KEYWORDS` with part names (lines 31–34) and `detectPartMention()` with another static list (lines 56–59).
- **`classifiedActionExecutor.ts`**: Dedup with full payload fingerprint IS implemented (djb2 hash, line 52–71).
- **`documentWriteEnvelope.ts`**: `segment_id` and `payload_fingerprint` fields ARE present (lines 4–5).
- **`driveRegistry.ts`**: Existing shared module that loads `01_INDEX` from Drive, parses aliases from Column B format, builds lookup maps. Already has `normalize()`, `scoreEntryMatch()`, `buildAliasLookup()`.

## What This Plan Does

Creates 3 new shared modules and modifies 4 existing files to replace all hardcoded identity lists with an authoritative registry-based resolution system.

## User's 4 Corrections (incorporated)

1. **`did_part_registry` is NEVER a fallback authority** — without `01_INDEX`, system enters safe mode (no new confirmations). Cache used only for previously confirmed identities.
2. **`can_be_session_target` not based on `last_seen_at` alone** — requires evidence of direct communicability from threads/sessions/therapist confirmation, not just a timestamp.
3. **`topicSegmentation` keeps part-name heuristics as candidate signals** — they help segmentation but never confirm identity. Final decision always via `resolveEntity()`.
4. **Alias match valid only from `01_INDEX`** — no string similarity, no model heuristics, no fuzzy matching for alias confirmation.

## New Files

### 1. `supabase/functions/_shared/entityRegistry.ts`

```text
Responsibilities:
- loadEntityRegistry(supabase, driveToken?) → EntityRegistry
- When driveToken available: loads 01_INDEX via existing loadDriveRegistryEntries()
  from driveRegistry.ts, builds lookup maps
- did_part_registry used ONLY as performance cache for previously confirmed parts
- SAFE MODE: when 01_INDEX unavailable AND cache entry doesn't have
  prior_confirmed_by_index=true → entity is uncertain
- Conflict between DB and 01_INDEX → uncertain_entity (fail-closed)

Exports:
- EntityRegistry object with:
  - lookupByName(name) → RegistryEntry | null
  - isConfirmedPart(name) → boolean
  - getCanonical(alias) → string | null
  - getPartNames() → string[]  (for segmentation candidate signals)
  - indexAvailable: boolean  (whether 01_INDEX was loaded)

Reuses: normalize(), parseAliases(), scoreEntryMatch() from driveRegistry.ts
```

### 2. `supabase/functions/_shared/entityResolution.ts`

```text
Types:
  EntityKind = "confirmed_did_part" | "confirmed_part_alias" | "external_person"
    | "animal" | "therapist" | "family_member" | "symbolic_inner_figure"
    | "inner_world_nonembodied" | "context_object" | "uncertain_entity"
    | "forbidden_as_part"

  ResolvedEntity = {
    raw_name, normalized_name, entity_kind, confidence,
    matched_part_id?, matched_canonical_name?, alias_match?,
    can_create_card, can_be_session_target,
    must_consult_therapists, must_write_context, must_write_trigger,
    reasons: string[]
  }

Core: resolveEntity(name, registry) → ResolvedEntity

Resolution order:
  1. Therapist names → therapist
  2. Forbidden safety net (small hardcoded: "zelená vesta", "bytostné já",
     "c.g.", "šašek", "indián") → forbidden_as_part
  3. Known non-DID (animals: "Locík"→animal; family→family_member;
     external: "Emma","Říha"→external_person)
  4. Registry canonical match (01_INDEX only) → confirmed_did_part
  5. Registry alias match (01_INDEX only, NOT fuzzy) → confirmed_part_alias
  6. No match → uncertain_entity

Permission rules:
  - can_create_card: true ONLY for confirmed_did_part / confirmed_part_alias
  - can_be_session_target: true ONLY when confirmed AND recent evidence of
    direct communicability exists (checked via: recent thread mentions with
    direct speech, therapist-confirmed communicability in did_pending_questions
    responses, or structured session evidence). NOT based on last_seen_at alone.
  - must_consult_therapists: true for uncertain_entity
  - must_write_context: true for external_person, animal, family_member,
    symbolic_inner_figure, inner_world_nonembodied

Alias validation:
  - Alias match is valid ONLY if alias exists in 01_INDEX
  - No string similarity matching
  - No model/AI heuristic for alias confirmation
  - No fuzzy matching for identity decisions
```

### 3. `supabase/functions/_shared/entityWatchdog.ts`

```text
Functions:
  - handleUncertainEntity(supabase, resolvedEntity, sourceContext)
    → creates did_pending_questions for BOTH therapists
    → enqueues KDO_JE_KDO write with context via did_pending_drive_writes
    → returns follow-up record

  - recordEntityContext(supabase, resolvedEntity, contextFacts)
    → writes relationship/trigger/role facts to existing docs:
      - KDO_JE_KDO for identity/role facts
      - PAMET_KAREL/DID/KONTEXTY/TRIGGERY for trigger associations
    → uses governed envelope for audit trail

No new DB tables. Uses existing:
  - did_pending_questions
  - did_pending_drive_writes
  - KDO_JE_KDO document
  - TRIGGERY document
```

## Modified Files

### 4. `supabase/functions/karel-daily-thread-sorter/index.ts`

- Remove `CONFIRMED_PARTS`, `ALIAS_MAP`, `NON_PART_ENTITIES`, `EXPLICITLY_UNCERTAIN` arrays
- Remove local `classifyEntity()` function
- Remove `scanForUncertainEntities()` (replaced by watchdog)
- Remove `createEntityFollowUp()` (replaced by watchdog)
- Import `loadEntityRegistry` + `resolveEntity` + `handleUncertainEntity`
- At start: `const registry = await loadEntityRegistry(supabase, driveToken)`
- In `processBlocksEntityGuardrails`: replace `classifyEntity(entityName)` with `resolveEntity(entityName, registry)`, map EntityKind to existing 4-way switch
- For `uncertain_entity`: call `handleUncertainEntity()` instead of local follow-up

### 5. `supabase/functions/karel-reactive-loop/index.ts`

- Remove hardcoded `DID_KEYWORDS` part name list (lines 31–34)
- Remove hardcoded `detectPartMention()` list (lines 56–59)
- Import `loadEntityRegistry` + `resolveEntity`
- Use registry for part detection, resolveEntity before card decisions

### 6. `supabase/functions/_shared/topicSegmentation.ts`

- Remove hardcoded `KNOWN_PARTS` array (lines 99–104)
- Keep part names in `PART_CLINICAL_KW` as **candidate signals only** (they help keyword-based segmentation detect clinical segments but do NOT confirm identity)
- `detectSegmentPart()` accepts optional `EntityRegistry` parameter:
  - When registry available: uses `registry.getPartNames()` for candidate detection, then caller uses `resolveEntity()` for final confirmation
  - When unavailable: returns null (safe — no false positives)
- Add comment: "Part name matches here are candidate signals only. Identity confirmation requires resolveEntity()."

### 7. `supabase/functions/_shared/signalNormalization.ts`

- Remove hardcoded `KNOWN_PARTS` array (lines 122–127)
- `detectPartInText()` accepts optional `EntityRegistry` parameter
- Same pattern: registry-aware candidate detection, safe fallback to null

## No Database Changes

No new tables, no migrations, no RLS changes.

## Guarantees

1. No `KARTA_*` without `01_INDEX` confirmation
2. No alias match without `01_INDEX` source
3. Uncertain entities → consultation workflow for both therapists
4. Without `01_INDEX` → safe mode (no new confirmations)
5. `can_be_session_target` requires communicability evidence, not just status
6. Part names in segmentation remain as candidate signals, never as identity authority

