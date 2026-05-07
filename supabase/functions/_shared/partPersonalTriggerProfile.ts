/**
 * P30.3 — Read personal trigger profile for a SINGLE today-relevant part.
 *
 * Source order:
 *   1. canonical Drive card via CARD_PHYSICAL_MAP / resolver
 *   2. did_part_profiles
 *   3. did_part_registry
 *   4. recent did_active_part_daily_brief
 *   5. source-backed fact cache (part_external_anchor_facts)
 *
 * Hard rules:
 *   - never send raw card text to provider
 *   - card missing → controlled_skip, NOT hallucination
 *   - concrete names/cases from card are anchors, NOT default query terms
 */

// deno-lint-ignore no-explicit-any
type SB = any;

export type CardReadStatus =
  | "read_ok"
  | "profile_only"
  | "card_missing"
  | "manual_approval_required"
  | "not_mapped";

export interface PartPersonalTriggerProfile {
  part_name: string;
  card_read_status: CardReadStatus;
  source_refs: Array<{
    source_type:
      | "drive_card"
      | "did_part_profiles"
      | "did_part_registry"
      | "active_part_daily_brief"
      | "source_backed_fact_cache";
    ref: string;
  }>;
  personal_triggers: Array<{
    trigger_label: string;
    trigger_category: string;
    description_safe: string;
    query_terms: string[];
    negative_terms: string[];
    example_terms: string[];
    confidence: "high" | "medium" | "low";
    source_ref: string;
  }>;
  biographical_anchors: Array<{
    anchor_label: string;
    anchor_type:
      | "real_world_case"
      | "symbolic_story"
      | "anniversary"
      | "death_date"
      | "birth_date"
      | "trauma_theme"
      | "unknown";
    canonical_entity_name?: string;
    known_dates: Array<{
      date: string;
      date_type: "death" | "birth" | "incident" | "anniversary" | "unknown";
      source_ref: string;
      verification_status:
        | "manual_verified"
        | "source_backed_unverified"
        | "pending_review";
    }>;
    theme_terms: string[];
    example_terms: string[];
    query_terms: string[];
    source_ref: string;
  }>;
  recommended_guards: Array<{
    guard_label: string;
    instruction_safe: string;
    source_ref: string;
  }>;
  controlled_skips: string[];
}

export interface LoadProfileInput {
  userId: string;
  partName: string;
  datePrague: string;
}

/**
 * Load profile from DB sources only (Drive card resolver is intentionally
 * out-of-scope for this slice — sentinel may inject a card resolver if
 * available; otherwise card_read_status='profile_only' or 'card_missing').
 */
export async function loadPartPersonalTriggerProfile(
  sb: SB,
  input: LoadProfileInput,
): Promise<PartPersonalTriggerProfile> {
  const profile: PartPersonalTriggerProfile = {
    part_name: input.partName,
    card_read_status: "card_missing",
    source_refs: [],
    personal_triggers: [],
    biographical_anchors: [],
    recommended_guards: [],
    controlled_skips: [],
  };

  // 1) did_part_profiles
  try {
    const { data: pp } = await sb
      .from("did_part_profiles")
      .select("*")
      .eq("user_id", input.userId)
      .eq("part_name", input.partName)
      .maybeSingle();
    if (pp) {
      profile.card_read_status = "profile_only";
      profile.source_refs.push({
        source_type: "did_part_profiles",
        ref: `did_part_profiles:${pp.id ?? input.partName}`,
      });
    }
  } catch { /* table optional */ }

  // 2) did_part_registry
  try {
    const { data: reg } = await sb
      .from("did_part_registry")
      .select("part_name, known_triggers, notes, status")
      .eq("user_id", input.userId)
      .eq("part_name", input.partName)
      .maybeSingle();
    if (reg) {
      profile.source_refs.push({
        source_type: "did_part_registry",
        ref: `did_part_registry:${input.partName}`,
      });
    }
  } catch { /* */ }

  // 3) sensitivities → personal_triggers (review-flagged terms only)
  try {
    const { data: sens } = await sb
      .from("part_external_event_sensitivities")
      .select(
        "id, part_name, event_pattern, sensitivity_types, recommended_guard, " +
          "safe_opening_style, query_terms, negative_terms, example_terms, " +
          "query_enabled, example_terms_query_enabled, query_policy, last_reviewed_at",
      )
      .eq("user_id", input.userId)
      .eq("part_name", input.partName)
      .eq("active", true);
    for (const s of (sens ?? []) as Array<any>) {
      const types: string[] = Array.isArray(s.sensitivity_types) ? s.sensitivity_types : [];
      const triggerCategory = mapSensitivityTypesToCategory(types);
      const queryTerms: string[] = Array.isArray(s.query_terms) ? s.query_terms : [];
      const negativeTerms: string[] = Array.isArray(s.negative_terms) ? s.negative_terms : [];
      const exampleTerms: string[] = Array.isArray(s.example_terms) ? s.example_terms : [];

      // event_pattern interpretation:
      //   - if it looks like a concrete entity (capitalized single word /
      //     proper noun), treat as biographical anchor example, NOT a trigger
      //   - if it looks like a category phrase (lowercase noun phrase),
      //     treat as a sensitivity-derived trigger category seed
      const isConcreteEntity = looksLikeProperNoun(s.event_pattern);

      if (isConcreteEntity) {
        profile.biographical_anchors.push({
          anchor_label: s.event_pattern,
          anchor_type: types.includes("animal_suffering") ? "symbolic_story" : "real_world_case",
          theme_terms: [],
          example_terms: [s.event_pattern, ...exampleTerms],
          query_terms: queryTerms,
          known_dates: [],
          source_ref: `sensitivity:${s.id}`,
        });
      } else {
        profile.personal_triggers.push({
          trigger_label: s.event_pattern,
          trigger_category: triggerCategory,
          description_safe: `Citlivost typu ${types.join(", ")}`,
          query_terms: queryTerms,
          negative_terms: negativeTerms,
          example_terms: exampleTerms,
          confidence: s.last_reviewed_at ? "high" : "medium",
          source_ref: `sensitivity:${s.id}`,
        });
      }

      if (s.recommended_guard) {
        profile.recommended_guards.push({
          guard_label: types[0] ?? "obecná",
          instruction_safe: s.recommended_guard,
          source_ref: `sensitivity:${s.id}`,
        });
      }
    }
  } catch { /* */ }

  // 4) anchor fact cache → enrich biographical anchors
  try {
    const { data: facts } = await sb
      .from("part_external_anchor_facts")
      .select(
        "anchor_label, anchor_type, canonical_entity_name, fact_type, fact_value, " +
          "fact_date, source_url, source_title, verification_status",
      )
      .eq("user_id", input.userId)
      .eq("part_name", input.partName)
      .limit(50);
    for (const f of (facts ?? []) as Array<any>) {
      profile.source_refs.push({
        source_type: "source_backed_fact_cache",
        ref: f.source_url,
      });
      const existing = profile.biographical_anchors.find(
        (a) => a.anchor_label.toLowerCase() === String(f.anchor_label ?? "").toLowerCase(),
      );
      const dateEntry = f.fact_date
        ? [{
            date: f.fact_date,
            date_type: (f.fact_type as any) ?? "unknown",
            source_ref: f.source_url,
            verification_status: f.verification_status ?? "source_backed_unverified",
          }]
        : [];
      if (existing) {
        existing.canonical_entity_name = existing.canonical_entity_name ?? f.canonical_entity_name;
        existing.known_dates.push(...dateEntry as any);
      } else {
        profile.biographical_anchors.push({
          anchor_label: f.anchor_label,
          anchor_type: (f.anchor_type as any) ?? "unknown",
          canonical_entity_name: f.canonical_entity_name ?? undefined,
          theme_terms: [],
          example_terms: [],
          query_terms: [],
          known_dates: dateEntry as any,
          source_ref: f.source_url,
        });
      }
    }
  } catch { /* */ }

  if (profile.source_refs.length === 0) {
    profile.controlled_skips.push("no_card_no_profile_no_sensitivities");
    profile.card_read_status = "card_missing";
  }

  return profile;
}

function looksLikeProperNoun(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  // Single capitalized word OR contains a hyphenated proper name
  if (/^[A-Z\u00C0-\u017E][a-zA-Z\u00C0-\u017E\-]*$/.test(t)) return true;
  if (/[A-Z][a-z]+\s*-\s*[A-Z][a-z]+/.test(t)) return true;
  // "Arthur Labinjo-Hughes" style
  if (/^[A-Z\u00C0-\u017E][a-z\u00C0-\u017E]+\s+[A-Z][\w\-]+/.test(t)) return true;
  return false;
}

export function mapSensitivityTypesToCategory(types: string[]): string {
  const set = new Set(types.map((s) => s.toLowerCase()));
  if (set.has("animal_suffering") || set.has("rescue_failure")) return "animal_suffering";
  if (set.has("child_abuse")) return "child_abuse";
  if (set.has("death")) return "death";
  if (set.has("disaster")) return "disaster";
  if (set.has("war")) return "war";
  if (set.has("anniversary")) return "anniversary";
  if (set.has("identity_link")) return "identity_link";
  if (set.has("injustice")) return "injustice";
  return "other";
}
