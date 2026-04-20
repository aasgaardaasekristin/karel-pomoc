/**
 * partIntelligenceFoundation.ts — Part Intelligence Foundation (PIF)
 *
 * Derived operational layer over canonical DID sources. NOT source of truth.
 *
 * Locked guarantees:
 *  - Reads ONLY from: did_observations (subject_type='part'), did_profile_claims,
 *    crisis_events, did_threads (DID sub_modes only), and canonical daily snapshot
 *  - NEVER touches `partner_personal` or `uncertain` Hana scopes
 *  - NEVER reads raw Drive content or prompt-prime cache
 *  - Returns `unknown` / low confidence when data is insufficient (no fabrication)
 *  - Pure function: takes canonical reads in, returns derived state out
 *
 * Foundation scope (NOT a final clinical scoring engine):
 *   activity, stability_signal, risk_signal, continuity, care_priority, confidence
 */

export const PART_FOUNDATION_VERSION = "v1.0.0";

export type Recentness = "active_today" | "active_week" | "stale" | "silent";
export type StabilityLevel = "stable" | "fluctuating" | "destabilizing" | "unknown";
export type RiskLevel = "low" | "moderate" | "elevated" | "critical" | "unknown";
export type ContinuityTrajectory =
  | "stable"
  | "changed"
  | "newly_active"
  | "recently_quiet"
  | "unknown";
export type CarePriority = "watch" | "support" | "active_care" | "crisis_focus" | "background";

export interface PartState {
  part_name: string;
  part_name_normalized: string;
  activity: {
    observations_24h: number;
    observations_7d: number;
    claims_7d: number;
    thread_messages_24h: number;
    thread_messages_7d: number;
    last_seen_at: string | null;
    recentness: Recentness;
  };
  stability_signal: {
    level: StabilityLevel;
    rationale: string;
    indicators: string[];
  };
  risk_signal: {
    level: RiskLevel;
    rationale: string;
    indicators: string[];
    has_open_crisis: boolean;
    crisis_severity: string | null;
    crisis_phase: string | null;
  };
  continuity: {
    trajectory: ContinuityTrajectory;
    rationale: string;
    appeared_in_previous_snapshot: boolean | null;
  };
  care_priority: {
    level: CarePriority;
    rationale: string;
  };
  confidence: {
    overall: number; // 0..1
    reasons: string[];
    insufficient_data: boolean;
  };
  source_window: { from: string; to: string };
  source_counts: {
    observations: number;
    claims: number;
    crisis_refs: number;
    thread_refs: number;
  };
}

export interface PartFoundationInput {
  now: Date;
  // Observations where subject_type='part'
  part_observations: Array<{
    id: string;
    subject_id?: string | null;
    fact?: string | null;
    created_at?: string;
    evidence_level?: string | null;
  }>;
  // did_profile_claims
  profile_claims: Array<{
    id: string;
    part_name?: string | null;
    claim_text?: string | null;
    card_section?: string | null;
    claim_type?: string | null;
    status?: string | null;
    created_at?: string;
  }>;
  // crisis_events (open + recent closed in last 14d)
  crises: Array<{
    id: string;
    part_name?: string | null;
    severity?: string | null;
    phase?: string | null;
    opened_at?: string | null;
    closed_at?: string | null;
  }>;
  // did_threads — DID sub-mode only (no Hana). Each thread carries part identity.
  did_threads: Array<{
    id: string;
    part_name?: string | null;
    current_detected_part?: string | null;
    sub_mode?: string | null;
    last_activity_at?: string | null;
    messages?: Array<{ role?: string; content?: string; timestamp?: string }>;
  }>;
  // Optional: previous WM snapshot's part_state (for continuity)
  previous_part_state?: {
    parts?: Array<{ part_name_normalized?: string; activity?: { recentness?: Recentness } }>;
  } | null;
}

// ── Helpers ──

function normalizePartName(raw?: string | null): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function classifyRecentness(lastIso: string | null, now: Date): Recentness {
  if (!lastIso) return "silent";
  const ageMs = now.getTime() - new Date(lastIso).getTime();
  if (ageMs <= 24 * 3600_000) return "active_today";
  if (ageMs <= 7 * 24 * 3600_000) return "active_week";
  if (ageMs <= 14 * 24 * 3600_000) return "stale";
  return "silent";
}

function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a ?? null;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function severityRank(sev: string | null | undefined): number {
  switch ((sev || "").toLowerCase()) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

// ── Per-part computation ──

interface PartBucket {
  display_name: string;
  normalized: string;
  observations: PartFoundationInput["part_observations"];
  claims: PartFoundationInput["profile_claims"];
  crises: PartFoundationInput["crises"];
  threads: PartFoundationInput["did_threads"];
}

function bucketize(input: PartFoundationInput): Map<string, PartBucket> {
  const buckets = new Map<string, PartBucket>();

  const ensure = (raw: string | null | undefined): PartBucket | null => {
    if (!raw) return null;
    const norm = normalizePartName(raw);
    if (!norm) return null;
    // Skip aggregate / non-part labels and the human/system actors
    const skip = new Set([
      "both", "team", "all", "system", "context",
      "karel", "kata", "hanka", "hanicka", "hanička",
      "mamka", "taticka", "tatínek", "tata", "táta",
    ]);
    if (skip.has(norm)) return null;
    let b = buckets.get(norm);
    if (!b) {
      b = {
        display_name: raw.trim(),
        normalized: norm,
        observations: [],
        claims: [],
        crises: [],
        threads: [],
      };
      buckets.set(norm, b);
    }
    return b;
  };

  for (const o of input.part_observations) {
    const b = ensure(o.subject_id);
    if (b) b.observations.push(o);
  }
  for (const c of input.profile_claims) {
    const b = ensure(c.part_name);
    if (b) b.claims.push(c);
  }
  for (const cr of input.crises) {
    const b = ensure(cr.part_name);
    if (b) b.crises.push(cr);
  }
  for (const th of input.did_threads) {
    const partLabel = th.part_name || th.current_detected_part;
    const b = ensure(partLabel);
    if (b) b.threads.push(th);
  }

  return buckets;
}

function computePartState(bucket: PartBucket, input: PartFoundationInput): PartState {
  const { now } = input;
  const cutoff24 = now.getTime() - 24 * 3600_000;
  const cutoff7d = now.getTime() - 7 * 24 * 3600_000;
  const from = new Date(cutoff7d).toISOString();
  const to = now.toISOString();

  // ── Activity ──
  const obs24h = bucket.observations.filter(
    (o) => o.created_at && new Date(o.created_at).getTime() >= cutoff24,
  ).length;
  const obs7d = bucket.observations.filter(
    (o) => o.created_at && new Date(o.created_at).getTime() >= cutoff7d,
  ).length;
  const claims7d = bucket.claims.filter(
    (c) => c.created_at && new Date(c.created_at).getTime() >= cutoff7d,
  ).length;

  // Thread messages within windows
  let msgs24h = 0;
  let msgs7d = 0;
  let lastThreadAt: string | null = null;
  for (const th of bucket.threads) {
    lastThreadAt = maxIso(lastThreadAt, th.last_activity_at ?? null);
    const msgs = Array.isArray(th.messages) ? th.messages : [];
    for (const m of msgs) {
      if (m.role !== "user") continue;
      const ts = m.timestamp;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (t >= cutoff7d) msgs7d++;
      if (t >= cutoff24) msgs24h++;
    }
  }

  const lastObsAt = bucket.observations
    .map((o) => o.created_at)
    .filter((x): x is string => !!x)
    .sort()
    .reverse()[0] ?? null;
  const lastClaimAt = bucket.claims
    .map((c) => c.created_at)
    .filter((x): x is string => !!x)
    .sort()
    .reverse()[0] ?? null;

  const last_seen_at = [lastObsAt, lastClaimAt, lastThreadAt].reduce(
    (acc, cur) => maxIso(acc, cur),
    null as string | null,
  );
  const recentness = classifyRecentness(last_seen_at, now);

  // ── Risk signal (data-driven, conservative) ──
  const openCrises = bucket.crises.filter(
    (c) => c.phase && !["closed", "CLOSED"].includes(c.phase),
  );
  const topCrisis = openCrises.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  )[0];
  const recentClosedCrisis = bucket.crises.find(
    (c) =>
      ["closed", "CLOSED"].includes(c.phase || "") &&
      c.closed_at &&
      new Date(c.closed_at).getTime() >= cutoff7d,
  );

  const riskIndicators: string[] = [];
  let riskLevel: RiskLevel = "unknown";
  let riskRationale = "Nedostatek dat pro odhad rizika.";

  if (openCrises.length > 0) {
    const sev = topCrisis?.severity || "medium";
    if (sev === "critical") {
      riskLevel = "critical";
      riskIndicators.push(`otevřená kritická krize (fáze ${topCrisis?.phase})`);
    } else if (sev === "high") {
      riskLevel = "elevated";
      riskIndicators.push(`otevřená vážná krize (fáze ${topCrisis?.phase})`);
    } else {
      riskLevel = "moderate";
      riskIndicators.push(`otevřená krize (sev ${sev}, fáze ${topCrisis?.phase})`);
    }
    riskRationale = `${openCrises.length} otevřená krize – nejvyšší severity ${sev}.`;
  } else if (recentClosedCrisis) {
    riskLevel = "moderate";
    riskIndicators.push("nedávno uzavřená krize (≤7 dní)");
    riskRationale = "Nedávno uzavřená krize – zvýšená pozornost vhodná, ale ne kritická.";
  } else if (obs7d >= 1 || claims7d >= 1 || msgs7d >= 1) {
    // Some data exists but no crisis signal
    riskLevel = "low";
    riskRationale = "Žádné krizové signály v posledních 7 dnech.";
  }
  // else: stays "unknown"

  // ── Stability signal (narrative-light, conservative) ──
  // Use observation/claim density vs activity baseline + crisis state.
  let stabilityLevel: StabilityLevel = "unknown";
  let stabilityRationale = "Nedostatek dat pro odhad stability.";
  const stabilityIndicators: string[] = [];

  const hasAnyData = obs7d + claims7d + msgs7d > 0;
  if (hasAnyData) {
    if (riskLevel === "critical" || riskLevel === "elevated") {
      stabilityLevel = "destabilizing";
      stabilityIndicators.push("krizový stav");
      stabilityRationale = "Otevřená vážná/kritická krize implikuje destabilizaci.";
    } else if (obs24h >= 3 && msgs24h === 0 && riskLevel === "moderate") {
      stabilityLevel = "fluctuating";
      stabilityIndicators.push("nárůst observací bez přímé komunikace");
      stabilityRationale = "Pozorování přibývají rychleji než přímý kontakt – sleduj.";
    } else if (recentness === "active_today" || recentness === "active_week") {
      stabilityLevel = "stable";
      stabilityRationale = "Pravidelná aktivita, žádné významné rizikové signály.";
    } else if (recentness === "stale") {
      stabilityLevel = "fluctuating";
      stabilityIndicators.push("ticho 7–14 dní");
      stabilityRationale = "Stagnace komunikace – sleduj, není to nutně regrese.";
    }
  }

  // ── Continuity ──
  const previousNorms = new Set(
    (input.previous_part_state?.parts || [])
      .map((p) => p.part_name_normalized)
      .filter((x): x is string => !!x),
  );
  const previousMatch = (input.previous_part_state?.parts || []).find(
    (p) => p.part_name_normalized === bucket.normalized,
  );

  let trajectory: ContinuityTrajectory = "unknown";
  let continuityRationale = "Bez předchozího snapshotu.";
  const appearedInPrev =
    input.previous_part_state ? previousNorms.has(bucket.normalized) : null;

  if (input.previous_part_state) {
    const prevRecent = previousMatch?.activity?.recentness;
    if (!previousMatch) {
      if (recentness === "active_today" || recentness === "active_week") {
        trajectory = "newly_active";
        continuityRationale = "Část se objevila nově ve srovnání s předchozím snapshotem.";
      } else {
        trajectory = "unknown";
        continuityRationale = "Část v předchozím snapshotu nebyla a nyní má slabý signál.";
      }
    } else if (
      (prevRecent === "active_today" || prevRecent === "active_week") &&
      (recentness === "stale" || recentness === "silent")
    ) {
      trajectory = "recently_quiet";
      continuityRationale = `Z aktivního stavu (${prevRecent}) přechází do ticha (${recentness}).`;
    } else if (
      (prevRecent === "stale" || prevRecent === "silent") &&
      (recentness === "active_today" || recentness === "active_week")
    ) {
      trajectory = "newly_active";
      continuityRationale = `Z ticha (${prevRecent}) přechází do aktivity (${recentness}).`;
    } else if (prevRecent === recentness) {
      trajectory = "stable";
      continuityRationale = `Stabilní recentness (${recentness}) napříč snapshoty.`;
    } else {
      trajectory = "changed";
      continuityRationale = `Recentness se posunul ${prevRecent} → ${recentness}.`;
    }
  }

  // ── Care priority (very conservative composition) ──
  let care: CarePriority = "background";
  let careRationale = "Žádné aktivní signály vyžadující pozornost.";
  if (riskLevel === "critical") {
    care = "crisis_focus";
    careRationale = "Otevřená kritická krize.";
  } else if (riskLevel === "elevated") {
    care = "active_care";
    careRationale = "Otevřená vážná krize – aktivní péče.";
  } else if (riskLevel === "moderate") {
    care = "support";
    careRationale = "Mírné rizikové signály – průběžná podpora.";
  } else if (recentness === "active_today" || recentness === "active_week") {
    care = "watch";
    careRationale = "Část je aktivní – sledování průběhu.";
  } else if (!hasAnyData) {
    care = "background";
    careRationale = "Bez dat v posledních 7 dnech.";
  }

  // ── Confidence ──
  const reasons: string[] = [];
  let confidenceOverall = 0;
  let insufficient = false;

  const sourceTotal = obs7d + claims7d + msgs7d + bucket.crises.length;
  if (sourceTotal === 0) {
    confidenceOverall = 0.05;
    insufficient = true;
    reasons.push("Žádná data za 7 dní – pouze referenční existence části.");
  } else {
    if (obs7d >= 3) reasons.push(`Dostatečná observační stopa (${obs7d}).`);
    else if (obs7d > 0) reasons.push(`Slabá observační stopa (${obs7d}).`);

    if (claims7d > 0) reasons.push(`${claims7d} čerstvých claim-rows.`);
    if (msgs7d > 0) reasons.push(`${msgs7d} přímých zpráv (DID thread).`);
    if (bucket.crises.length > 0) reasons.push(`${bucket.crises.length} crisis refs.`);

    const obsW = Math.min(0.35, obs7d * 0.05);
    const claimW = Math.min(0.2, claims7d * 0.06);
    const msgW = Math.min(0.25, msgs7d * 0.03);
    const crisisW = openCrises.length > 0 ? 0.15 : (bucket.crises.length > 0 ? 0.08 : 0);
    const recencyW =
      recentness === "active_today" ? 0.1 :
      recentness === "active_week" ? 0.06 :
      recentness === "stale" ? 0.02 : 0;
    confidenceOverall = +(obsW + claimW + msgW + crisisW + recencyW).toFixed(3);
    if (confidenceOverall < 0.2) insufficient = true;
  }

  return {
    part_name: bucket.display_name,
    part_name_normalized: bucket.normalized,
    activity: {
      observations_24h: obs24h,
      observations_7d: obs7d,
      claims_7d: claims7d,
      thread_messages_24h: msgs24h,
      thread_messages_7d: msgs7d,
      last_seen_at,
      recentness,
    },
    stability_signal: {
      level: stabilityLevel,
      rationale: stabilityRationale,
      indicators: stabilityIndicators,
    },
    risk_signal: {
      level: riskLevel,
      rationale: riskRationale,
      indicators: riskIndicators,
      has_open_crisis: openCrises.length > 0,
      crisis_severity: topCrisis?.severity ?? null,
      crisis_phase: topCrisis?.phase ?? null,
    },
    continuity: {
      trajectory,
      rationale: continuityRationale,
      appeared_in_previous_snapshot: appearedInPrev,
    },
    care_priority: {
      level: care,
      rationale: careRationale,
    },
    confidence: {
      overall: confidenceOverall,
      reasons,
      insufficient_data: insufficient,
    },
    source_window: { from, to },
    source_counts: {
      observations: bucket.observations.length,
      claims: bucket.claims.length,
      crisis_refs: bucket.crises.length,
      thread_refs: bucket.threads.length,
    },
  };
}

// ── Public entry ──

export interface PartIntelligenceFoundationOutput {
  version: string;
  generated_at: string;
  generated_from: {
    sources: string[];
    excluded_sources: string[];
    excluded_scopes: string[];
  };
  notice: string;
  parts: PartState[];
  summary: {
    total_parts: number;
    parts_with_open_crisis: number;
    parts_active_today: number;
    parts_silent: number;
    avg_confidence: number | null;
  };
}

export function computePartIntelligenceFoundation(
  input: PartFoundationInput,
): PartIntelligenceFoundationOutput {
  const buckets = bucketize(input);
  const parts: PartState[] = [];
  for (const bucket of buckets.values()) {
    parts.push(computePartState(bucket, input));
  }
  // Sort: crisis_focus → active_care → support → watch → background; tie-break by activity
  const careRank: Record<CarePriority, number> = {
    crisis_focus: 0,
    active_care: 1,
    support: 2,
    watch: 3,
    background: 4,
  };
  parts.sort((a, b) => {
    const r = careRank[a.care_priority.level] - careRank[b.care_priority.level];
    if (r !== 0) return r;
    return b.activity.observations_7d + b.activity.thread_messages_7d -
           (a.activity.observations_7d + a.activity.thread_messages_7d);
  });

  const confs = parts.map((p) => p.confidence.overall).filter((n) => n > 0);
  const avgConf = confs.length > 0
    ? +(confs.reduce((s, n) => s + n, 0) / confs.length).toFixed(3)
    : null;

  return {
    version: PART_FOUNDATION_VERSION,
    generated_at: input.now.toISOString(),
    generated_from: {
      sources: [
        "did_observations(subject_type=part)",
        "did_profile_claims",
        "crisis_events",
        "did_threads(DID sub_modes only)",
        "previous WM snapshot (continuity hint)",
      ],
      excluded_sources: [
        "karel_hana_conversations (any scope)",
        "karel_episodes (HANA private)",
        "raw Drive content",
        "context_cache (prompt-prime only)",
      ],
      excluded_scopes: ["partner_personal", "uncertain"],
    },
    notice:
      "Part Intelligence Foundation is a derived operational layer. " +
      "It reads ONLY from canonical DID evidence + crisis + DID threads. " +
      "Hana partner_personal/uncertain content is firewalled out by construction. " +
      "When data is insufficient, returns 'unknown' / low confidence.",
    parts,
    summary: {
      total_parts: parts.length,
      parts_with_open_crisis: parts.filter((p) => p.risk_signal.has_open_crisis).length,
      parts_active_today: parts.filter((p) => p.activity.recentness === "active_today").length,
      parts_silent: parts.filter((p) => p.activity.recentness === "silent").length,
      avg_confidence: avgConf,
    },
  };
}
