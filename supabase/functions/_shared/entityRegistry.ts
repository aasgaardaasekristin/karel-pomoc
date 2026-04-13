/**
 * entityRegistry.ts — FÁZE 2.6
 *
 * Authoritative entity registry for DID part identity resolution.
 *
 * SOLE AUTHORITY: 01_INDEX (loaded from Drive via driveRegistry.ts)
 * did_part_registry (DB) = cache/mirror ONLY — never confirms new entities.
 *
 * SAFE MODE: when 01_INDEX is unavailable, system cannot confirm new entities.
 * Cache is used only for previously confirmed identities (prior_confirmed_by_index=true).
 *
 * On conflict between DB and 01_INDEX → uncertain_entity (fail-closed).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  normalize,
  loadDriveRegistryEntries,
  type DriveRegistryEntry,
} from "./driveRegistry.ts";

// ── Types ──

export interface RegistryEntry {
  id: string;
  canonicalName: string;
  normalizedCanonical: string;
  aliases: string[];
  normalizedAliases: string[];
  status: string;
  /** Whether this entry was confirmed by 01_INDEX (not just DB cache) */
  confirmedByIndex: boolean;
}

export interface EntityRegistry {
  /** Whether 01_INDEX was successfully loaded */
  indexAvailable: boolean;
  /** All confirmed entries */
  entries: RegistryEntry[];
  /** Lookup by normalized canonical name */
  lookupByName(name: string): RegistryEntry | null;
  /** Check if a name (canonical or alias) is a confirmed part in 01_INDEX */
  isConfirmedPart(name: string): boolean;
  /** Get canonical name for an alias (only from 01_INDEX aliases) */
  getCanonical(alias: string): string | null;
  /** Get all confirmed part names (for segmentation candidate signals) */
  getPartNames(): string[];
  /** Get all names + aliases (for candidate detection in segmentation) */
  getAllKnownNames(): string[];
}

// ── Loader ──

/**
 * Load entity registry. 01_INDEX is the sole authority.
 *
 * @param supabase - Supabase client for DB cache access
 * @param driveToken - Google Drive OAuth token (optional). When provided, loads 01_INDEX.
 *
 * BEHAVIOR:
 * - With driveToken: loads 01_INDEX → builds authoritative registry
 * - Without driveToken: loads did_part_registry as cache ONLY
 *   - Cache entries are marked confirmedByIndex=false
 *   - These entries can be used for candidate detection but NEVER confirm new entities
 * - On conflict between DB and 01_INDEX: entry is excluded (fail-closed)
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

  // 2. Build registry from 01_INDEX entries
  const entries: RegistryEntry[] = [];
  const byNormalizedCanonical = new Map<string, RegistryEntry>();
  const byNormalizedAlias = new Map<string, RegistryEntry>();

  if (indexAvailable) {
    for (const driveEntry of indexEntries) {
      const entry: RegistryEntry = {
        id: driveEntry.id,
        canonicalName: driveEntry.primaryName,
        normalizedCanonical: driveEntry.normalizedName,
        aliases: driveEntry.aliases,
        normalizedAliases: driveEntry.normalizedAliases,
        status: driveEntry.status,
        confirmedByIndex: true,
      };

      entries.push(entry);
      byNormalizedCanonical.set(entry.normalizedCanonical, entry);
      for (const aliasNorm of entry.normalizedAliases) {
        byNormalizedAlias.set(aliasNorm, entry);
      }
    }
  } else {
    // SAFE MODE: load from DB cache, but mark as NOT confirmed by index
    console.warn("[entityRegistry] SAFE MODE: 01_INDEX unavailable, using DB cache (no new confirmations)");
    try {
      const { data: dbParts } = await supabase
        .from("did_part_registry")
        .select("part_id, part_name, aliases, status")
        .limit(200);

      if (dbParts && dbParts.length > 0) {
        for (const row of dbParts) {
          const rawName = String(row.part_name || "").trim();
          if (!rawName) continue;

          const rawAliases = Array.isArray(row.aliases)
            ? (row.aliases as string[]).map(a => String(a).trim()).filter(Boolean)
            : [];

          const entry: RegistryEntry = {
            id: String(row.part_id || ""),
            canonicalName: rawName,
            normalizedCanonical: normalize(rawName),
            aliases: rawAliases,
            normalizedAliases: rawAliases.map(normalize),
            status: String(row.status || ""),
            confirmedByIndex: false, // CRITICAL: cache entries are NOT authority
          };

          entries.push(entry);
          byNormalizedCanonical.set(entry.normalizedCanonical, entry);
          for (const aliasNorm of entry.normalizedAliases) {
            byNormalizedAlias.set(aliasNorm, entry);
          }
        }
        console.log(`[entityRegistry] DB cache loaded: ${entries.length} entries (non-authoritative)`);
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
      // CRITICAL: only entries confirmed by 01_INDEX can confirm parts
      return entry.confirmedByIndex;
    },

    getCanonical(alias: string): string | null {
      const norm = normalize(alias);
      // Check alias map first
      const aliasEntry = byNormalizedAlias.get(norm);
      if (aliasEntry && aliasEntry.confirmedByIndex) return aliasEntry.canonicalName;
      // Check canonical map
      const canonicalEntry = byNormalizedCanonical.get(norm);
      if (canonicalEntry && canonicalEntry.confirmedByIndex) return canonicalEntry.canonicalName;
      return null;
    },

    getPartNames(): string[] {
      return entries.map(e => e.canonicalName);
    },

    getAllKnownNames(): string[] {
      const names: string[] = [];
      for (const e of entries) {
        names.push(e.canonicalName);
        names.push(...e.aliases);
      }
      return names;
    },
  };

  return registry;
}
