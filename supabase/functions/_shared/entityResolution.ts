/**
 * entityResolution.ts — FÁZE 2.6
 *
 * Entity classification and permission resolution.
 *
 * Classifies entity names into 11 EntityKind types and derives
 * permission flags (can_create_new_card, can_write_existing_card,
 * can_be_session_target, etc.).
 *
 * RULES:
 * - Alias match is valid ONLY if alias exists in 01_INDEX
 * - No string similarity, no AI heuristics, no fuzzy matching
 * - can_create_new_card = true ONLY for confirmed_by_index
 * - can_write_existing_card = true for confirmed_by_index OR confirmed_by_index_mirror
 * - can_be_session_target requires additional communicability evidence
 * - Without 01_INDEX → no new confirmations (fail-closed)
 */

import { normalize } from "./driveRegistry.ts";
import type { EntityRegistry, RegistryEntry } from "./entityRegistry.ts";

// ── Types ──

export type EntityKind =
  | "confirmed_did_part"
  | "confirmed_part_alias"
  | "external_person"
  | "animal"
  | "therapist"
  | "family_member"
  | "symbolic_inner_figure"
  | "inner_world_nonembodied"
  | "context_object"
  | "uncertain_entity"
  | "forbidden_as_part";

export interface ResolvedEntity {
  raw_name: string;
  normalized_name: string;
  entity_kind: EntityKind;
  confidence: number;
  matched_part_id?: string | null;
  matched_canonical_name?: string | null;
  alias_match?: boolean;
  /** Can a NEW card (KARTA_*) be created for this entity? Only confirmed_by_index. */
  can_create_new_card: boolean;
  /** Can data be written to an EXISTING card? confirmed_by_index OR confirmed_by_index_mirror. */
  can_write_existing_card: boolean;
  can_be_session_target: boolean;
  must_consult_therapists: boolean;
  must_write_context: boolean;
  must_write_trigger: boolean;
  reasons: string[];
}

// ── Hardcoded Safety Nets ──
// Small static lists for entities that must NEVER be classified as DID parts.
// These are a safety net — the registry is the primary authority.

const THERAPIST_NAMES_NORM = new Set([
  "hanicka", "hanka", "hana", "hanička",
  "kata", "katka", "kaca", "káťa",
].map(normalize));

const FORBIDDEN_ENTITIES_NORM = new Set([
  "zelena vesta", "bytostne ja", "c.g.", "cg",
  "sasek", "indian",
].map(normalize));

const ANIMAL_ENTITIES_NORM = new Set([
  "locik", "locek",
].map(normalize));

const KNOWN_EXTERNAL_PERSONS_NORM = new Set([
  "emma", "ema", "emily",
  "riha",
].map(normalize));

const KNOWN_FAMILY_MEMBERS_NORM = new Set([
  "amalka", "tonicka",
].map(normalize));

// ── Core Resolution ──

/**
 * Resolve an entity name against the registry and safety nets.
 *
 * Resolution order (first match wins):
 *   1. Therapist names → therapist
 *   2. Forbidden entities → forbidden_as_part
 *   3. Known animals → animal
 *   4. Known external persons → external_person
 *   5. Known family members → family_member
 *   6. Registry canonical match → confirmed_did_part (only if confirmedByIndex)
 *   7. Registry alias match → confirmed_part_alias (only if confirmedByIndex)
 *   8. No match → uncertain_entity
 *
 * @param name - Raw entity name to resolve
 * @param registry - Loaded EntityRegistry
 * @param communicabilityEvidence - Optional: recent evidence that the part
 *   is directly communicable (from threads, sessions, therapist confirmation).
 *   NOT based on last_seen_at alone.
 */
export function resolveEntity(
  name: string,
  registry: EntityRegistry,
  communicabilityEvidence?: boolean,
): ResolvedEntity {
  const norm = normalize(name);
  const reasons: string[] = [];

  // 1. Therapist names
  if (THERAPIST_NAMES_NORM.has(norm)) {
    return buildResult(name, norm, "therapist", null, {
      reasons: ["Matched therapist name safety net"],
    });
  }

  // 2. Forbidden entities
  if (FORBIDDEN_ENTITIES_NORM.has(norm)) {
    return buildResult(name, norm, "forbidden_as_part", null, {
      reasons: ["Matched forbidden entity safety net"],
    });
  }

  // 3. Known animals
  if (ANIMAL_ENTITIES_NORM.has(norm)) {
    return buildResult(name, norm, "animal", null, {
      reasons: ["Matched known animal entity"],
      must_write_context: true,
    });
  }

  // 4. Known external persons
  if (KNOWN_EXTERNAL_PERSONS_NORM.has(norm)) {
    return buildResult(name, norm, "external_person", null, {
      reasons: ["Matched known external person"],
      must_write_context: true,
    });
  }

  // 5. Known family members
  if (KNOWN_FAMILY_MEMBERS_NORM.has(norm)) {
    return buildResult(name, norm, "family_member", null, {
      reasons: ["Matched known family member"],
      must_write_context: true,
    });
  }

  // 6-7. Registry lookup (canonical + alias)
  const entry = registry.lookupByName(name);

  if (entry) {
    if (entry.confirmationTier === "confirmed_by_index" || entry.confirmationTier === "confirmed_by_index_mirror") {
      // Confirmed part (either live index or audit-stamped mirror)
      const isAlias = entry.normalizedCanonical !== norm;
      const kind: EntityKind = isAlias ? "confirmed_part_alias" : "confirmed_did_part";

      // Permission split:
      // - can_create_new_card: ONLY live index (creating a brand new KARTA_* requires live authority)
      // - can_write_existing_card: index OR mirror (writing to an already existing card is safe)
      const canCreateNew = entry.confirmationTier === "confirmed_by_index";
      const canWriteExisting = true; // both index and mirror tiers can write to existing cards

      return buildResult(name, norm, kind, entry, {
        alias_match: isAlias,
        confidence: entry.confirmationTier === "confirmed_by_index" ? 1.0 : 0.9,
        can_create_new_card: canCreateNew,
        can_write_existing_card: canWriteExisting,
        can_be_session_target: !!communicabilityEvidence,
        reasons: [
          isAlias
            ? `Alias match (${entry.confirmationTier}): ${name} → ${entry.canonicalName}`
            : `Canonical match (${entry.confirmationTier}): ${entry.canonicalName}`,
          ...(communicabilityEvidence
            ? ["Communicability evidence present → can_be_session_target"]
            : ["No communicability evidence → can_be_session_target=false"]),
          ...(entry.confirmationTier === "confirmed_by_index_mirror"
            ? ["Mirror tier: can write to existing cards, cannot create new ones"]
            : []),
        ],
      });
    } else {
      // unconfirmed_cache_only → uncertain (fail-closed)
      reasons.push(
        `Found in DB cache as "${entry.canonicalName}" but NO index_confirmed_at stamp — unconfirmed_cache_only, fail-closed`,
      );
      return buildResult(name, norm, "uncertain_entity", null, {
        reasons,
        must_consult_therapists: true,
        confidence: 0.2,
      });
    }
  }

  // 8. No match → uncertain
  if (!registry.indexAvailable) {
    reasons.push("01_INDEX unavailable (safe mode) — cannot confirm new entities");
  } else {
    reasons.push("Not found in 01_INDEX registry");
  }
  reasons.push("Entity requires therapist verification before any card creation");

  return buildResult(name, norm, "uncertain_entity", null, {
    reasons,
    must_consult_therapists: true,
  });
}

// ── Helpers ──

interface ResultOverrides {
  confidence?: number;
  alias_match?: boolean;
  can_create_new_card?: boolean;
  can_write_existing_card?: boolean;
  can_be_session_target?: boolean;
  must_consult_therapists?: boolean;
  must_write_context?: boolean;
  must_write_trigger?: boolean;
  reasons?: string[];
}

function buildResult(
  rawName: string,
  normalizedName: string,
  kind: EntityKind,
  entry: RegistryEntry | null,
  overrides: ResultOverrides = {},
): ResolvedEntity {
  const defaults = getKindDefaults(kind);
  return {
    raw_name: rawName,
    normalized_name: normalizedName,
    entity_kind: kind,
    confidence: overrides.confidence ?? defaults.confidence,
    matched_part_id: entry?.id ?? null,
    matched_canonical_name: entry?.canonicalName ?? null,
    alias_match: overrides.alias_match ?? false,
    can_create_new_card: overrides.can_create_new_card ?? defaults.can_create_new_card,
    can_write_existing_card: overrides.can_write_existing_card ?? defaults.can_write_existing_card,
    can_be_session_target: overrides.can_be_session_target ?? defaults.can_be_session_target,
    must_consult_therapists: overrides.must_consult_therapists ?? defaults.must_consult_therapists,
    must_write_context: overrides.must_write_context ?? defaults.must_write_context,
    must_write_trigger: overrides.must_write_trigger ?? defaults.must_write_trigger,
    reasons: overrides.reasons ?? [],
  };
}

interface KindDefaults {
  confidence: number;
  can_create_new_card: boolean;
  can_write_existing_card: boolean;
  can_be_session_target: boolean;
  must_consult_therapists: boolean;
  must_write_context: boolean;
  must_write_trigger: boolean;
}

function getKindDefaults(kind: EntityKind): KindDefaults {
  switch (kind) {
    case "confirmed_did_part":
      return { confidence: 1.0, can_create_new_card: true, can_write_existing_card: true, can_be_session_target: false, must_consult_therapists: false, must_write_context: false, must_write_trigger: false };
    case "confirmed_part_alias":
      return { confidence: 1.0, can_create_new_card: true, can_write_existing_card: true, can_be_session_target: false, must_consult_therapists: false, must_write_context: false, must_write_trigger: false };
    case "therapist":
      return { confidence: 1.0, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: false, must_write_trigger: false };
    case "forbidden_as_part":
      return { confidence: 1.0, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: false, must_write_trigger: false };
    case "external_person":
      return { confidence: 0.9, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "animal":
      return { confidence: 0.9, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "family_member":
      return { confidence: 0.9, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "symbolic_inner_figure":
      return { confidence: 0.7, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "inner_world_nonembodied":
      return { confidence: 0.7, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "context_object":
      return { confidence: 0.5, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: false, must_write_context: true, must_write_trigger: false };
    case "uncertain_entity":
      return { confidence: 0.3, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: true, must_write_context: true, must_write_trigger: false };
    default:
      return { confidence: 0.1, can_create_new_card: false, can_write_existing_card: false, can_be_session_target: false, must_consult_therapists: true, must_write_context: false, must_write_trigger: false };
  }
}

/**
 * Map EntityKind to the legacy 4-way classification used by thread-sorter guardrails.
 * This bridges the new resolution system with existing block processing logic.
 */
export function toLegacyClassification(resolved: ResolvedEntity): {
  classification: "confirmed_part" | "known_alias_of_part" | "uncertain_entity" | "non_part_context";
  canonicalName?: string;
  nonPartReason?: string;
} {
  switch (resolved.entity_kind) {
    case "confirmed_did_part":
      return { classification: "confirmed_part" };
    case "confirmed_part_alias":
      return {
        classification: "known_alias_of_part",
        canonicalName: resolved.matched_canonical_name || undefined,
      };
    case "therapist":
      return { classification: "non_part_context", nonPartReason: "terapeut" };
    case "forbidden_as_part":
      return { classification: "non_part_context", nonPartReason: "zakázaná entita (ne DID část)" };
    case "external_person":
      return { classification: "non_part_context", nonPartReason: "reálná osoba" };
    case "animal":
      return { classification: "non_part_context", nonPartReason: "zvíře" };
    case "family_member":
      return { classification: "non_part_context", nonPartReason: "rodinný příslušník" };
    case "symbolic_inner_figure":
      return { classification: "non_part_context", nonPartReason: "symbolická/vnitřní bytost" };
    case "inner_world_nonembodied":
      return { classification: "non_part_context", nonPartReason: "vnitřní neztělesněná postava" };
    case "context_object":
      return { classification: "non_part_context", nonPartReason: "kontextový objekt" };
    case "uncertain_entity":
      return { classification: "uncertain_entity" };
    default:
      return { classification: "uncertain_entity" };
  }
}
