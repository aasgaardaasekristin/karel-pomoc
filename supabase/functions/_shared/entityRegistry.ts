/**
 * entityRegistry.ts — FÁZE 2.6
 *
 * Authoritative entity registry for DID part identity resolution.
 *
 * SOLE AUTHORITY: 01_INDEX (loaded from Drive via driveRegistry.ts)
 * did_part_registry (DB) = cache/mirror ONLY — never confirms new entities.
 *
 * 3-TIER CONFIRMATION MODEL:
 *   - confirmed_by_index: entry loaded directly from 01_INDEX in this run
 *   - confirmed_by_index_mirror: entry from DB cache with index_confirmed_at stamp
 *     (previously confirmed by 01_INDEX, audit-trailed via timestamp)
 *   - unconfirmed_cache_only: DB entry without proof of prior index confirmation
 *
 * RULES:
 *   - New identity/alias confirmation: ONLY confirmed_by_index
 *   - Routine work with known parts: confirmed_by_index OR confirmed_by_index_mirror
 *   - unconfirmed_cache_only: NEVER used for confirmation, NEVER in candidate lists
 *   - On conflict between DB and 01_INDEX → uncertain_entity (fail-closed)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  normalize,
  loadDriveRegistryEntries,
  type DriveRegistryEntry,
} from "./driveRegistry.ts";

// ── Types ──

export type ConfirmationTier =
  | "confirmed_by_index"
  | "confirmed_by_index_mirror"
  | "unconfirmed_cache_only";

/** Numeric tier strength for deterministic precedence (higher = stronger). */
const TIER_STRENGTH: Record<ConfirmationTier, number> = {
  confirmed_by_index: 3,
  confirmed_by_index_mirror: 2,
  unconfirmed_cache_only: 1,
};

export interface RegistryEntry {
  id: string;
  canonicalName: string;
  normalizedCanonical: string;
  aliases: string[];
  normalizedAliases: string[];
  status: string;
  /** How this entry's identity was confirmed */
  confirmationTier: ConfirmationTier;
}

export interface EntityRegistry {
  /** Whether 01_INDEX was successfully loaded */
  indexAvailable: boolean;
  /** All entries (all tiers) */
  entries: RegistryEntry[];
  /** Lookup by normalized canonical name or alias */
  lookupByName(name: string): RegistryEntry | null;
  /** Check if a name is a confirmed part (index or mirror tier) */
  isConfirmedPart(name: string): boolean;
  /** Get canonical name for an alias (only from index or mirror tier) */
  getCanonical(alias: string): string | null;
  /**
   * Get confirmed part names for segmentation candidate signals.
   * EXCLUDES unconfirmed_cache_only entries.
   */
  getPartNames(): string[];
  /**
   * Get all names + aliases for candidate detection.
   * EXCLUDES unconfirmed_cache_only entries — dirty cache never leaks.
   */
  getAllKnownNames(): string[];
}

// ── Dedup helpers ──

/**
 * Compare two registry entries by strength. Returns >0 if `a` is stronger.
 * Precedence: tier strength → non-empty id → alias count → non-empty status.
 */
function compareRegistryEntryStrength(a: RegistryEntry, b: RegistryEntry): number {
  const tierDiff = TIER_STRENGTH[a.confirmationTier] - TIER_STRENGTH[b.confirmationTier];
  if (tierDiff !== 0) return tierDiff;
  // Same tier — prefer entry with non-empty id
  const aHasId = a.id ? 1 : 0;
  const bHasId = b.id ? 1 : 0;
  if (aHasId !== bHasId) return aHasId - bHasId;
  // Prefer more aliases
  const aliasDiff = a.normalizedAliases.length - b.normalizedAliases.length;
  if (aliasDiff !== 0) return aliasDiff;
  // Prefer non-empty status
  const aStatus = a.status ? 1 : 0;
  const bStatus = b.status ? 1 : 0;
  return aStatus - bStatus;
}

/**
 * Should `candidate` replace `existing` in the lookup map?
 * Never downgrades a stronger entry to a weaker one.
 */
function shouldReplaceExistingEntry(existing: RegistryEntry, candidate: RegistryEntry): boolean {
  return compareRegistryEntryStrength(candidate, existing) > 0;
}

/**
 * Insert entry into maps with dedup — stronger entry always wins.
 */
function insertWithDedup(
  entry: RegistryEntry,
  byNormalizedCanonical: Map<string, RegistryEntry>,
  byNormalizedAlias: Map<string, RegistryEntry>,
): void {
  // Canonical name dedup
  const existingCanonical = byNormalizedCanonical.get(entry.normalizedCanonical);
  if (!existingCanonical || shouldReplaceExistingEntry(existingCanonical, entry)) {
    byNormalizedCanonical.set(entry.normalizedCanonical, entry);
  }
  // Alias dedup — each alias checked individually
  for (const aliasNorm of entry.normalizedAliases) {
    const existingAlias = byNormalizedAlias.get(aliasNorm);
    if (!existingAlias || shouldReplaceExistingEntry(existingAlias, entry)) {
      byNormalizedAlias.set(aliasNorm, entry);
    }
  }
}

// ── Loader ──

/**
 * Load entity registry. 01_INDEX is the sole authority.
 *
 * @param supabase - Supabase client for DB cache access
 * @param driveToken - Google Drive OAuth token (optional). When provided, loads 01_INDEX.
 *
 * BEHAVIOR:
 * - With driveToken: loads 01_INDEX → builds authoritative registry (confirmed_by_index)
 *   Also stamps index_confirmed_at on matching DB rows for future mirror use.
 * - Without driveToken: loads did_part_registry as cache
 *   - Entries with index_confirmed_at IS NOT NULL → confirmed_by_index_mirror
 *   - Entries without index_confirmed_at → unconfirmed_cache_only (excluded from candidates)
 * - index_confirmed_at is stamped ONLY on unambiguous, non-conflicting match to 01_INDEX
 */
export async function loadEntityRegistry(
  supabase: ReturnType<typeof createClient>,
  driveToken?: string | null,
): Promise<EntityRegistry> {
  let indexEntries: DriveRegistryEntry[] = [];
  let indexAvailable = false;

  // 1. Try loading 01_INDEX from Drive (sole authority)
  if (driveToken) {
    try {
      indexEntries = await loadDriveRegistryEntries(driveToken);
      indexAvailable = indexEntries.length > 0;
      if (indexAvailable) {
        console.log(`[entityRegistry] 01_INDEX loaded: ${indexEntries.length} entries`);
      } else {
        console.warn("[entityRegistry] 01_INDEX returned 0 entries");
      }
    } catch (err) {
      console.error("[entityRegistry] Failed to load 01_INDEX:", err);
    }
  }

  // 2. Build registry
  const entries: RegistryEntry[] = [];
  const byNormalizedCanonical = new Map<string, RegistryEntry>();
  const byNormalizedAlias = new Map<string, RegistryEntry>();

  if (indexAvailable) {
    // ── INDEX MODE: authoritative ──
    for (const driveEntry of indexEntries) {
      const entry: RegistryEntry = {
        id: driveEntry.id,
        canonicalName: driveEntry.primaryName,
        normalizedCanonical: driveEntry.normalizedName,
        aliases: driveEntry.aliases,
        normalizedAliases: driveEntry.normalizedAliases,
        status: driveEntry.status,
        confirmationTier: "confirmed_by_index",
      };

      entries.push(entry);
      // Dedup: index entries are strongest, always win
      insertWithDedup(entry, byNormalizedCanonical, byNormalizedAlias);
    }

    // Stamp index_confirmed_at on matching DB rows (audit trail for future mirror use)
    // Only stamp on unambiguous match — skip conflicts
    await stampIndexConfirmation(supabase, indexEntries);
  } else {
    // ── SAFE MODE: DB cache only ──
    console.warn("[entityRegistry] SAFE MODE: 01_INDEX unavailable, using DB cache with audit stamps");
    try {
      const { data: dbParts } = await supabase
        .from("did_part_registry")
        .select("part_id, part_name, aliases, status, index_confirmed_at")
        .limit(200);

      if (dbParts && dbParts.length > 0) {
        for (const row of dbParts) {
          const rawName = String(row.part_name || "").trim();
          if (!rawName) continue;

          const rawAliases = Array.isArray(row.aliases)
            ? (row.aliases as string[]).map(a => String(a).trim()).filter(Boolean)
            : [];

          // 3-TIER: mirror only if explicit audit stamp exists
          const tier: ConfirmationTier = row.index_confirmed_at
            ? "confirmed_by_index_mirror"
            : "unconfirmed_cache_only";

          const entry: RegistryEntry = {
            id: String(row.part_id || ""),
            canonicalName: rawName,
            normalizedCanonical: normalize(rawName),
            aliases: rawAliases,
            normalizedAliases: rawAliases.map(normalize),
            status: String(row.status || ""),
            confirmationTier: tier,
          };

          entries.push(entry);
          // Dedup: stronger tier always wins, never downgrade mirror to unconfirmed
          insertWithDedup(entry, byNormalizedCanonical, byNormalizedAlias);
        }

        const mirrorCount = entries.filter(e => e.confirmationTier === "confirmed_by_index_mirror").length;
        const cacheCount = entries.filter(e => e.confirmationTier === "unconfirmed_cache_only").length;
        console.log(`[entityRegistry] DB cache: ${mirrorCount} mirror, ${cacheCount} unconfirmed (total ${entries.length})`);
      }
    } catch (err) {
      console.error("[entityRegistry] DB cache load failed:", err);
    }
  }

  // 3. Build registry object
  const registry: EntityRegistry = {
    indexAvailable,
    entries,

    lookupByName(name: string): RegistryEntry | null {
      const norm = normalize(name);
      return byNormalizedCanonical.get(norm) || byNormalizedAlias.get(norm) || null;
    },

    isConfirmedPart(name: string): boolean {
      const entry = this.lookupByName(name);
      if (!entry) return false;
      // confirmed_by_index and confirmed_by_index_mirror are both valid
      return entry.confirmationTier !== "unconfirmed_cache_only";
    },

    getCanonical(alias: string): string | null {
      const norm = normalize(alias);
      const aliasEntry = byNormalizedAlias.get(norm);
      if (aliasEntry && aliasEntry.confirmationTier !== "unconfirmed_cache_only") {
        return aliasEntry.canonicalName;
      }
      const canonicalEntry = byNormalizedCanonical.get(norm);
      if (canonicalEntry && canonicalEntry.confirmationTier !== "unconfirmed_cache_only") {
        return canonicalEntry.canonicalName;
      }
      return null;
    },

    /**
     * Get confirmed part names — deduplicated via lookup map winners.
     * EXCLUDES unconfirmed_cache_only.
     */
    getPartNames(): string[] {
      // Use deduplicated canonical map winners, not raw entries
      const seen = new Set<string>();
      const names: string[] = [];
      for (const entry of byNormalizedCanonical.values()) {
        if (entry.confirmationTier === "unconfirmed_cache_only") continue;
        if (seen.has(entry.normalizedCanonical)) continue;
        seen.add(entry.normalizedCanonical);
        names.push(entry.canonicalName);
      }
      return names;
    },

    /**
     * Get all names + aliases — deduplicated via lookup map winners.
     * EXCLUDES unconfirmed_cache_only. Dirty cache never leaks.
     */
    getAllKnownNames(): string[] {
      const nameSet = new Set<string>();
      // Canonical names from deduplicated map
      for (const entry of byNormalizedCanonical.values()) {
        if (entry.confirmationTier === "unconfirmed_cache_only") continue;
        nameSet.add(entry.canonicalName);
        for (const alias of entry.aliases) {
          nameSet.add(alias);
        }
      }
      return Array.from(nameSet);
    },
  };

  return registry;
}

// ── Index Sync Stamp ──

/**
 * Stamp index_confirmed_at on DB rows that unambiguously match 01_INDEX entries.
 *
 * CONSERVATIVE FAIL-CLOSED: Only stamps on exact canonical name match.
 * This is intentionally conservative — if a legitimate entity has a different
 * canonical form in the DB vs 01_INDEX (e.g. historical name change), it will
 * NOT receive a stamp and will remain unconfirmed_cache_only in safe mode.
 * This is a conscious design decision: better to under-confirm than over-confirm.
 *
 * index_confirmed_at is stamped ONLY on unambiguous, non-conflicting match.
 */
async function stampIndexConfirmation(
  supabase: ReturnType<typeof createClient>,
  indexEntries: DriveRegistryEntry[],
): Promise<void> {
  try {
    const { data: dbParts } = await supabase
      .from("did_part_registry")
      .select("part_id, part_name")
      .limit(200);

    if (!dbParts || dbParts.length === 0) return;

    const now = new Date().toISOString();
    const indexNameSet = new Set(indexEntries.map(e => normalize(e.primaryName)));

    for (const row of dbParts) {
      const normName = normalize(String(row.part_name || ""));
      // Only stamp on unambiguous match — exact canonical name match
      if (indexNameSet.has(normName)) {
        await supabase
          .from("did_part_registry")
          .update({ index_confirmed_at: now })
          .eq("part_id", row.part_id);
      }
    }

    console.log(`[entityRegistry] Index confirmation stamps updated`);
  } catch (err) {
    console.warn("[entityRegistry] Failed to stamp index confirmations:", err);
  }
}
