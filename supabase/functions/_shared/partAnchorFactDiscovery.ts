/**
 * P30.3 — Source-backed anchor fact discovery + cache.
 *
 * Hard rules:
 *   - never lookup by partName alone
 *   - "Arthur" alone does NOT allow "Arthur Labinjo-Hughes" lookup
 *   - "Tundrupek" alone does NOT allow "Timmy" lookup
 *   - lookup requires explicit anchor hint from card/profile/cache
 *   - every discovered fact MUST have a real http(s) source URL
 *   - store as source_backed_unverified or pending_review
 *   - never auto-confirm clinically
 *
 * Card backfill: NOT performed automatically. We only enqueue an append-only
 * review-labeled write through the governance helper (caller's responsibility).
 */

import type { PartPersonalTriggerProfile } from "./partPersonalTriggerProfile.ts";

// deno-lint-ignore no-explicit-any
type SB = any;

export interface DiscoveryInput {
  userId: string;
  partName: string;
  profile: PartPersonalTriggerProfile;
  /**
   * Explicit lookup hints (proper-noun phrases derived from the card/profile).
   * If empty → no lookup is performed.
   */
  allowedLookupHints: string[];
}

export interface PartExternalAnchorFact {
  user_id: string;
  part_name: string;
  anchor_label: string;
  anchor_type: string;
  canonical_entity_name?: string | null;
  fact_type: string;
  fact_value: string;
  fact_date?: string | null;
  source_url: string;
  source_title?: string | null;
  source_domain?: string | null;
  verification_status: "source_backed_unverified" | "pending_review";
}

export interface DiscoveredAnchorFactResult {
  attempted: number;
  cached_hits: number;
  newly_discovered: number;
  refused_by_part_name_only: number;
  refused_no_source_url: number;
  facts: PartExternalAnchorFact[];
  warnings: string[];
}

/**
 * Discovery is provider-agnostic: this slice only reads existing cache and
 * surfaces refusal reasons. Actual provider-driven discovery is intentionally
 * a future enhancement — P30.3 must NOT silently invent facts.
 */
export async function discoverAndCacheMissingPartAnchorFacts(
  sb: SB,
  input: DiscoveryInput,
): Promise<DiscoveredAnchorFactResult> {
  const result: DiscoveredAnchorFactResult = {
    attempted: 0,
    cached_hits: 0,
    newly_discovered: 0,
    refused_by_part_name_only: 0,
    refused_no_source_url: 0,
    facts: [],
    warnings: [],
  };

  // Refuse if hint is just the part name itself
  const partNameLower = input.partName.toLowerCase();
  const safeHints = input.allowedLookupHints.filter((h) => {
    const hl = h.trim().toLowerCase();
    if (!hl) return false;
    if (hl === partNameLower) {
      result.refused_by_part_name_only++;
      return false;
    }
    return true;
  });

  if (safeHints.length === 0) return result;

  // Read cache for these hints
  try {
    const { data: cached } = await sb
      .from("part_external_anchor_facts")
      .select(
        "user_id, part_name, anchor_label, anchor_type, canonical_entity_name, " +
          "fact_type, fact_value, fact_date, source_url, source_title, source_domain, verification_status",
      )
      .eq("user_id", input.userId)
      .eq("part_name", input.partName)
      .in("anchor_label", safeHints);
    for (const f of (cached ?? []) as Array<any>) {
      if (!f.source_url || !/^https?:\/\//i.test(f.source_url)) {
        result.refused_no_source_url++;
        continue;
      }
      result.cached_hits++;
      result.facts.push(f as PartExternalAnchorFact);
    }
  } catch (e) {
    result.warnings.push(`cache_read_failed:${(e as Error).message}`);
  }

  // Provider-driven discovery is opt-in and not enabled in this slice.
  // Future: call externalRealitySearchProvider with hint queries and persist
  // ONLY rows where source_url passes the http(s) check; mark as pending_review.

  return result;
}
