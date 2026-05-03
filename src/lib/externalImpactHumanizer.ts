/**
 * P11: ExternalLoadWarning humanizer + clustering.
 *
 * Backend stores raw classifier metadata (e.g. "animal_suffering",
 * "rescue_failure", "broken_promise", reasons in the form
 * `Část X má citlivost na vzor "Y" (typy: a, b)`) as data.
 * The visible clinical surface MUST NEVER show that.
 *
 * This module:
 *   1. Strips internal classifier tokens (P11 markers, `[p11_dedup_acknowledged]`,
 *      `(typy: ...)`, underscore_words) from raw `reason` / `recommended_action`.
 *   2. Replaces classifier event_type codes with human Czech phrases.
 *   3. Aggregates multiple impacts about the same theme for the same part
 *      into a single display card so the panel never shows 6 redundant cards
 *      for one clinical theme.
 *
 * Pure TypeScript. No React. No DB. Easily testable.
 */

export type RawExternalImpact = {
  id: string;
  event_id: string;
  part_name: string;
  risk_level: "watch" | "amber" | "red";
  reason: string;
  recommended_action: string | null;
  external_reality_events?: {
    event_title: string;
    event_type: string;
    source_type: string;
    verification_status: string;
    graphic_content_risk: string;
    summary_for_therapists: string;
  } | null;
};

export type DisplayExternalImpact = {
  /** Stable display key (part + theme cluster) */
  key: string;
  part_name: string;
  risk_level: "watch" | "amber" | "red";
  /** Short human label, e.g. "Téma velryby Timmy". No raw tokens. */
  theme_label: string;
  /** Body text, fully humanized. */
  body: string;
  /** Optional recommendation, fully humanized. */
  recommendation: string | null;
  /** How many raw impacts this card aggregates (for diagnostics, not UI). */
  source_impact_ids: string[];
};

// ---------------------------------------------------------------------------
// Cleaners
// ---------------------------------------------------------------------------

/** Removes internal markers, classifier code blocks, and stray underscore tokens. */
export function stripInternalMarkers(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  // P11 dedup audit prefix
  s = s.replace(/\[p11_dedup_acknowledged\]\s*/gi, "");
  s = s.replace(/\[P\d+_[a-z0-9_]+\]\s*/gi, "");
  // "(typy: animal_suffering, rescue_failure)" → ""
  s = s.replace(/\((?:typy|types)\s*:[^)]*\)/gi, "");
  // Bare underscore tokens left behind ("animal_suffering", "broken_promise")
  s = s.replace(/\b[a-z]+(?:_[a-z]+){1,3}\b/gi, "");
  // Double spaces / leftover whitespace before punctuation
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// ---------------------------------------------------------------------------
// Theme inference
// ---------------------------------------------------------------------------

/**
 * Infer a normalized theme cluster key from event_title / event_type.
 * Whale + Timmy + animal-cruelty for Tundrupek collapse into one cluster.
 */
export function inferThemeCluster(
  eventTitle: string,
  eventType: string,
  partName: string,
): { cluster: string; label: string } {
  const t = (eventTitle || "").toLowerCase();
  const type = (eventType || "").toLowerCase();
  const partLower = (partName || "").toLowerCase();

  const isAnimalSuffering =
    type === "animal_suffering" ||
    /velryb|timm|t[ýy]r[áa]n[ií] zv[ií]\u0159|zv[ií]\u0159at|whale/.test(t);

  // Tundrupek + animal-suffering theme → Timmy/whale cluster
  if (isAnimalSuffering && /tundrupek/.test(partLower)) {
    return {
      cluster: "tundrupek_timmy_whale_animal_distress",
      label: "téma velryby Timmy a zvířecí bezmoci",
    };
  }
  if (isAnimalSuffering) {
    return {
      cluster: `animal_distress::${partLower}`,
      label: "téma zvířecí bezmoci",
    };
  }

  // Generic fallback by event title (already human Czech)
  const safeTitle = (eventTitle || "").trim() || "vnější téma";
  return {
    cluster: `theme::${partLower}::${safeTitle.toLowerCase()}`,
    label: `téma „${safeTitle}"`,
  };
}

// ---------------------------------------------------------------------------
// Per-card body / recommendation
// ---------------------------------------------------------------------------

const HUMAN_BODY_BY_CLUSTER: Record<string, string> = {
  tundrupek_timmy_whale_animal_distress:
    "Téma velryby Timmy a zvířecí bezmoci může dnes Tundrupka emočně zatížit. Není to důkaz o tom, co prožívá; je potřeba to jemně ověřit, ne vykládat.",
};

const HUMAN_RECO_BY_CLUSTER: Record<string, string> = {
  tundrupek_timmy_whale_animal_distress:
    "Začněte krátkým ověřením těla, emoce a pocitu bezpečí. Nepředkládejte grafické detaily ani neověřené zprávy. Pokud se objeví zahlcení, vraťte se ke stabilizaci.",
};

const GENERIC_BODY =
  "Toto vnější téma může dnes části způsobit zvýšenou citlivost. Není to důkaz o tom, co prožívá; je potřeba to jemně ověřit, ne vykládat.";

const GENERIC_RECO =
  "Začněte krátkým ověřením těla, emoce a pocitu bezpečí. Nepředkládejte grafické detaily ani neověřené zprávy. Pokud se objeví zahlcení, vraťte se ke stabilizaci.";

// ---------------------------------------------------------------------------
// Public: cluster + humanize
// ---------------------------------------------------------------------------

const RISK_RANK: Record<DisplayExternalImpact["risk_level"], number> = {
  watch: 0,
  amber: 1,
  red: 2,
};

export function clusterAndHumanizeExternalImpacts(
  impacts: RawExternalImpact[],
): DisplayExternalImpact[] {
  if (!Array.isArray(impacts) || impacts.length === 0) return [];

  // Group by (part_name, theme cluster)
  const groups = new Map<string, RawExternalImpact[]>();
  const labels = new Map<string, string>();

  for (const imp of impacts) {
    const ev = imp.external_reality_events;
    const { cluster, label } = inferThemeCluster(
      ev?.event_title ?? "",
      ev?.event_type ?? "",
      imp.part_name,
    );
    const groupKey = `${imp.part_name}::${cluster}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      labels.set(groupKey, label);
    }
    groups.get(groupKey)!.push(imp);
  }

  const cards: DisplayExternalImpact[] = [];
  for (const [groupKey, group] of groups) {
    // Worst risk wins
    const worst = group.reduce((acc, x) =>
      RISK_RANK[x.risk_level] >= RISK_RANK[acc.risk_level] ? x : acc,
    );
    const themeLabel = labels.get(groupKey) ?? "vnější téma";
    const clusterCode = groupKey.split("::").slice(1).join("::");

    const body =
      HUMAN_BODY_BY_CLUSTER[clusterCode] ??
      HUMAN_BODY_BY_CLUSTER[clusterCode.split("::")[0]] ??
      GENERIC_BODY;

    // Try to use human recommended_action from canonical impact, but stripped.
    const recoRaw = stripInternalMarkers(worst.recommended_action ?? "");
    const recoFromCluster =
      HUMAN_RECO_BY_CLUSTER[clusterCode] ??
      HUMAN_RECO_BY_CLUSTER[clusterCode.split("::")[0]];
    const reco = recoFromCluster ?? (recoRaw.length > 0 ? recoRaw : GENERIC_RECO);

    cards.push({
      key: groupKey,
      part_name: worst.part_name,
      risk_level: worst.risk_level,
      theme_label: themeLabel,
      body,
      recommendation: reco,
      source_impact_ids: group.map((g) => g.id),
    });
  }

  // Stable sort: red first, then amber, then watch; within risk by part name
  cards.sort((a, b) => {
    if (RISK_RANK[a.risk_level] !== RISK_RANK[b.risk_level]) {
      return RISK_RANK[b.risk_level] - RISK_RANK[a.risk_level];
    }
    return a.part_name.localeCompare(b.part_name, "cs");
  });

  return cards;
}
