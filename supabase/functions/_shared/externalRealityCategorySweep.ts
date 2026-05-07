/**
 * P30.3 — General daily external trigger sweep.
 *
 * Category templates are NOT global always-on queries. A template may be
 * instantiated only when at least one today-relevant part has a matching
 * trigger_category extracted from card/profile/source-backed anchor/reviewed
 * sensitivity/weekly matrix history.
 */

import type { TodayRelevantPartContext } from "./todayRelevantParts.ts";
import type { PartPersonalTriggerProfile } from "./partPersonalTriggerProfile.ts";
import type { PartExternalAnchorFact } from "./partAnchorFactDiscovery.ts";

export interface SweepQueryInput {
  datePrague: string;
  relevantParts: TodayRelevantPartContext[];
  profiles: PartPersonalTriggerProfile[];
  anchorFacts: PartExternalAnchorFact[];
  maxQueries?: number;
}

export interface SweepQuery {
  query: string;
  trigger_category: string;
  matched_part_names: string[];
}

interface CategoryTemplate {
  category_keys: string[];
  query: string;
}

const TEMPLATES: CategoryTemplate[] = [
  {
    category_keys: ["animal_suffering", "helpless_animal", "animal_rescue", "animal_abuse"],
    query: "týrání zvířat aktuální zprávy",
  },
  {
    category_keys: ["animal_suffering", "rescue_failure", "helpless_animal"],
    query: "uvízlé zvíře záchrana aktuální zprávy",
  },
  {
    category_keys: ["animal_rescue", "animal_suffering"],
    query: "záchrana zvířete aktuální zprávy",
  },
  {
    category_keys: ["child_abuse", "child_protection_failure"],
    query: "násilí na dětech aktuální zprávy",
  },
  {
    category_keys: ["child_protection_failure", "child_abuse"],
    query: "selhání ochrany dítěte aktuální zprávy",
  },
  {
    category_keys: ["child_abuse", "public_trial"],
    query: "soud týrání dítěte aktuální zprávy",
  },
  {
    category_keys: ["disaster", "child_abuse"],
    query: "katastrofa děti aktuální zprávy",
  },
];

function partCategorySet(profile: PartPersonalTriggerProfile): Set<string> {
  const set = new Set<string>();
  for (const t of profile.personal_triggers) set.add(t.trigger_category.toLowerCase());
  for (const a of profile.biographical_anchors) {
    for (const tt of a.theme_terms) set.add(tt.toLowerCase());
  }
  return set;
}

export function buildGeneralExternalTriggerSweepQueries(
  input: SweepQueryInput,
): SweepQuery[] {
  const max = Math.max(1, Math.min(20, input.maxQueries ?? 7));
  const out: SweepQuery[] = [];
  const seen = new Set<string>();

  // For each template, instantiate ONLY if at least one today-relevant part has matching category
  for (const tmpl of TEMPLATES) {
    const matched: string[] = [];
    for (const p of input.profiles) {
      const cats = partCategorySet(p);
      if (tmpl.category_keys.some((k) => cats.has(k))) {
        matched.push(p.part_name);
      }
    }
    if (matched.length === 0) continue;
    if (seen.has(tmpl.query)) continue;
    seen.add(tmpl.query);
    out.push({
      query: tmpl.query,
      trigger_category: tmpl.category_keys[0],
      matched_part_names: matched,
    });
    if (out.length >= max) break;
  }

  return out;
}
