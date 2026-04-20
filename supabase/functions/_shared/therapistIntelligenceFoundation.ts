/**
 * therapistIntelligenceFoundation.ts — Therapist Intelligence Foundation
 *
 * Derived operational layer over canonical sources. NOT source of truth.
 *
 * Locked guarantees:
 *  - Reads ONLY from role-classified `therapeutic_team` data + evidence + tasks + crisis
 *  - NEVER touches `partner_personal` or `uncertain` Hana messages
 *  - For `mixed` Hana messages → uses ONLY `therapeutic_team` segments
 *  - Returns `unknown` / low confidence when data is insufficient (no fabrication)
 *  - Pure function: takes canonical reads in, returns derived state out
 *
 * Foundation scope (NOT final scoring engine):
 *   activity, signal_quality, support_need, continuity, confidence
 */

export type TherapistKey = "hanka" | "kata";

export type Recentness = "active_today" | "active_week" | "stale" | "silent";
export type SupportLevel = "low" | "moderate" | "elevated" | "unknown";

export interface TherapistState {
  therapist: TherapistKey;
  activity: {
    therapeutic_messages_24h: number;
    therapeutic_messages_7d: number;
    last_therapeutic_at: string | null;
    recentness: Recentness;
  };
  signal_quality: {
    score: number | null; // 0..1
    rationale: string;
    sample_size: number;
  };
  support_need: {
    level: SupportLevel;
    rationale: string;
    indicators: string[];
  };
  continuity: {
    score: number | null; // 0..1
    open_tasks: number;
    completed_tasks_7d: number;
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
    implications: number;
    tasks: number;
    therapeutic_messages: number;
    crises_owned: number;
  };
}

export interface FoundationVersion {
  version: string;
  generated_at: string;
  notice: string;
}

export const FOUNDATION_VERSION = "v1.0.0";

// ── Input shape (canonical reads passed in) ──

export interface TherapistFoundationInput {
  now: Date;
  // Hana conversation messages already pre-filtered to user_id; we re-filter on role_scope
  hana_messages: Array<{
    role?: string;
    content?: string;
    role_scope?: string;
    role_scope_meta?: { confidence?: number; needs_role_review?: boolean };
    role_scope_segments?: Array<{ scope: string; confidence?: number }>;
    timestamp?: string;
    created_at?: string;
  }>;
  // Káťa: did_threads + did_conversations with sub_mode='kata'
  kata_threads: Array<{
    id: string;
    sub_mode?: string;
    last_activity_at?: string | null;
    messages?: Array<{ role?: string; content?: string; timestamp?: string }>;
  }>;
  // Evidence (already last 7d)
  observations: Array<{
    id: string;
    subject_type?: string;
    subject_id?: string;
    fact?: string;
    created_at?: string;
    evidence_level?: string;
  }>;
  implications: Array<{
    id: string;
    owner?: string | null;
    destinations?: any;
    impact_type?: string;
    status?: string;
    created_at?: string;
  }>;
  // Therapist tasks
  tasks: Array<{
    id: string;
    assigned_to?: string;
    status?: string;
    title?: string;
    created_at?: string;
    completed_at?: string | null;
  }>;
  // Crisis ownership
  crises: Array<{
    id: string;
    primary_therapist?: string | null;
    secondary_therapist?: string | null;
    severity?: string;
    phase?: string;
  }>;
}

// ── Helpers ──

function isTherapeuticHanaMessage(m: TherapistFoundationInput["hana_messages"][number]): boolean {
  if (m.role !== "user") return false;
  const scope = m.role_scope;
  if (scope === "therapeutic_team") return true;
  if (scope === "mixed" && Array.isArray(m.role_scope_segments)) {
    return m.role_scope_segments.some((s) => s.scope === "therapeutic_team");
  }
  // partner_personal / uncertain / unclassified → NOT therapist intelligence input
  return false;
}

function msgTimestamp(m: { timestamp?: string; created_at?: string }): string | null {
  return m.timestamp ?? m.created_at ?? null;
}

function classifyRecentness(lastIso: string | null, now: Date): Recentness {
  if (!lastIso) return "silent";
  const ageMs = now.getTime() - new Date(lastIso).getTime();
  if (ageMs <= 24 * 3600_000) return "active_today";
  if (ageMs <= 7 * 24 * 3600_000) return "active_week";
  if (ageMs <= 14 * 24 * 3600_000) return "stale";
  return "silent";
}

function ownsTherapist(value: string | null | undefined, key: TherapistKey): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v.includes(key);
}

// ── Per-therapist computation ──

function computeHanka(input: TherapistFoundationInput): TherapistState {
  const { now } = input;
  const from = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const to = now.toISOString();
  const cutoff24 = now.getTime() - 24 * 3600_000;

  // Activity: only therapeutic_team Hana messages (or therapeutic segments of mixed)
  const therapeuticMsgs = input.hana_messages.filter(isTherapeuticHanaMessage);
  const therapeuticTimestamps = therapeuticMsgs
    .map(msgTimestamp)
    .filter((t): t is string => !!t)
    .sort();
  const last_therapeutic_at = therapeuticTimestamps.length
    ? therapeuticTimestamps[therapeuticTimestamps.length - 1]
    : null;
  const therapeutic_messages_7d = therapeuticMsgs.length;
  const therapeutic_messages_24h = therapeuticMsgs.filter((m) => {
    const t = msgTimestamp(m);
    return t ? new Date(t).getTime() >= cutoff24 : false;
  }).length;

  // Source counts (Hanka-related)
  const obsHanka = input.observations.filter(
    (o) => (o.subject_type === "therapist" && (o.subject_id || "").toLowerCase().includes("hanka")) ||
           ((o.fact || "").toLowerCase().includes("hanka") && o.subject_type === "therapist"),
  );
  const implHanka = input.implications.filter((i) => ownsTherapist(i.owner, "hanka"));
  const tasksHanka = input.tasks.filter((t) => ownsTherapist(t.assigned_to, "hanka"));
  const crisesHanka = input.crises.filter(
    (c) => ownsTherapist(c.primary_therapist, "hanka") || ownsTherapist(c.secondary_therapist, "hanka"),
  );

  return composeState({
    therapist: "hanka",
    therapeutic_messages_24h,
    therapeutic_messages_7d,
    last_therapeutic_at,
    therapeuticMsgsRaw: therapeuticMsgs,
    obs: obsHanka,
    impl: implHanka,
    tasks: tasksHanka,
    crises: crisesHanka,
    from,
    to,
    now,
  });
}

function computeKata(input: TherapistFoundationInput): TherapistState {
  const { now } = input;
  const from = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const to = now.toISOString();
  const cutoff24 = now.getTime() - 24 * 3600_000;

  // Káťa activity: did_threads with sub_mode='kata'
  const kataThreads = input.kata_threads.filter((t) => (t.sub_mode || "").toLowerCase() === "kata");

  // Flatten messages from kata threads (those ARE therapeutic by domain definition)
  const kataMessages: Array<{ ts: string | null }> = [];
  for (const th of kataThreads) {
    const msgs = Array.isArray(th.messages) ? th.messages : [];
    for (const m of msgs) {
      if (m.role === "user") {
        kataMessages.push({ ts: msgTimestamp(m) });
      }
    }
  }
  const kataTimestamps = kataMessages
    .map((m) => m.ts)
    .filter((t): t is string => !!t)
    .sort();
  const last_therapeutic_at = kataTimestamps.length
    ? kataTimestamps[kataTimestamps.length - 1]
    : (kataThreads.length
        ? kataThreads
            .map((t) => t.last_activity_at)
            .filter((x): x is string => !!x)
            .sort()
            .reverse()[0] ?? null
        : null);

  const therapeutic_messages_7d = kataMessages.length;
  const therapeutic_messages_24h = kataMessages.filter(
    (m) => m.ts && new Date(m.ts).getTime() >= cutoff24,
  ).length;

  const obsKata = input.observations.filter(
    (o) => o.subject_type === "therapist" && (o.subject_id || "").toLowerCase().includes("kat"),
  );
  const implKata = input.implications.filter((i) => ownsTherapist(i.owner, "kata"));
  const tasksKata = input.tasks.filter((t) => ownsTherapist(t.assigned_to, "kata"));
  const crisesKata = input.crises.filter(
    (c) => ownsTherapist(c.primary_therapist, "kata") || ownsTherapist(c.secondary_therapist, "kata"),
  );

  // Build pseudo-messages list for sample_size in signal_quality
  const therapeuticMsgsRaw = kataMessages.map((m) => ({
    role: "user",
    role_scope: "therapeutic_team",
    timestamp: m.ts ?? undefined,
  })) as TherapistFoundationInput["hana_messages"];

  return composeState({
    therapist: "kata",
    therapeutic_messages_24h,
    therapeutic_messages_7d,
    last_therapeutic_at,
    therapeuticMsgsRaw,
    obs: obsKata,
    impl: implKata,
    tasks: tasksKata,
    crises: crisesKata,
    from,
    to,
    now,
  });
}

interface ComposeArgs {
  therapist: TherapistKey;
  therapeutic_messages_24h: number;
  therapeutic_messages_7d: number;
  last_therapeutic_at: string | null;
  therapeuticMsgsRaw: TherapistFoundationInput["hana_messages"];
  obs: TherapistFoundationInput["observations"];
  impl: TherapistFoundationInput["implications"];
  tasks: TherapistFoundationInput["tasks"];
  crises: TherapistFoundationInput["crises"];
  from: string;
  to: string;
  now: Date;
}

function composeState(a: ComposeArgs): TherapistState {
  const recentness = classifyRecentness(a.last_therapeutic_at, a.now);

  // ── signal_quality ──
  // Foundation: average confidence of role_scope classifications + small bonus
  // for evidence rows (relevance proxy). NEVER fabricate when sample is too small.
  let qualityScore: number | null = null;
  let qualityRationale = "Nedostatek dat (méně než 3 terapeutické vstupy za 7 dní).";
  const sample_size = a.therapeutic_messages_7d;

  if (sample_size >= 3) {
    const confidences = a.therapeuticMsgsRaw
      .map((m) => m.role_scope_meta?.confidence)
      .filter((c): c is number => typeof c === "number");
    const avgConf =
      confidences.length > 0
        ? confidences.reduce((s, c) => s + c, 0) / confidences.length
        : 0.7; // Káťa threads have no role_scope_meta → assume 0.7 baseline
    const evidenceBonus = Math.min(0.15, a.obs.length * 0.02 + a.impl.length * 0.03);
    qualityScore = Math.min(1, +(avgConf * 0.85 + evidenceBonus).toFixed(3));
    qualityRationale =
      `Avg klasifikační confidence ${avgConf.toFixed(2)} (n=${confidences.length || "kata-threads"}), ` +
      `evidence bonus +${evidenceBonus.toFixed(2)} z ${a.obs.length} observací a ${a.impl.length} implikací.`;
  }

  // ── support_need ──
  const indicators: string[] = [];
  let supportLevel: SupportLevel = "unknown";
  let supportRationale = "Nedostatek dat pro odhad zátěže.";

  const openTasks = a.tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const completedTasks7d = a.tasks.filter((t) => t.status === "completed" && t.completed_at).length;
  const ownedCrises = a.crises.length;
  const highSeverityCrises = a.crises.filter((c) => c.severity === "high" || c.severity === "critical").length;

  if (openTasks > 0 || a.therapeutic_messages_7d > 0 || ownedCrises > 0) {
    let load = 0;
    if (openTasks >= 5) {
      indicators.push(`${openTasks} otevřených úkolů`);
      load += 1;
    }
    if (highSeverityCrises >= 1) {
      indicators.push(`${highSeverityCrises} vysoce závažné krize`);
      load += 2;
    } else if (ownedCrises >= 2) {
      indicators.push(`${ownedCrises} aktivních krizí`);
      load += 1;
    }
    if (a.therapeutic_messages_24h >= 30) {
      indicators.push(`vysoká aktivita 24h (${a.therapeutic_messages_24h} zpráv)`);
      load += 1;
    }
    if (recentness === "silent" && openTasks > 0) {
      indicators.push("ticho při otevřených úkolech");
      load += 1;
    }

    if (load >= 3) {
      supportLevel = "elevated";
      supportRationale = `Více souběžných zátěžových signálů (load=${load}).`;
    } else if (load >= 1) {
      supportLevel = "moderate";
      supportRationale = `Střední zátěž (load=${load}).`;
    } else {
      supportLevel = "low";
      supportRationale = "Aktivita bez výraznějších zátěžových signálů.";
    }
  }

  // ── continuity ──
  let continuityScore: number | null = null;
  let continuityRationale = "Nedostatek tasků/vláken pro odhad kontinuity.";
  const totalTaskActivity = openTasks + completedTasks7d;

  if (totalTaskActivity >= 2) {
    // Continuity proxy: completion ratio + activity recency
    const completionRatio = completedTasks7d / Math.max(1, totalTaskActivity);
    const recencyFactor = recentness === "active_today" ? 1
      : recentness === "active_week" ? 0.7
      : recentness === "stale" ? 0.3
      : 0;
    continuityScore = +(0.6 * completionRatio + 0.4 * recencyFactor).toFixed(3);
    continuityRationale =
      `Completion ratio ${completionRatio.toFixed(2)} (${completedTasks7d}/${totalTaskActivity}) × recency ${recencyFactor}.`;
  } else if (a.therapeutic_messages_7d >= 5) {
    // Bare minimum: derive only from message activity recency
    const recencyFactor = recentness === "active_today" ? 0.7
      : recentness === "active_week" ? 0.4
      : 0.1;
    continuityScore = recencyFactor;
    continuityRationale = `Nízká task aktivita; návaznost odvozena jen z message recency (${recentness}).`;
  }

  // ── confidence ──
  const reasons: string[] = [];
  let confidenceOverall = 0;
  let insufficient = false;

  if (a.therapeutic_messages_7d === 0 && a.tasks.length === 0 && a.obs.length === 0) {
    confidenceOverall = 0.05;
    insufficient = true;
    reasons.push("Žádná terapeutická aktivita ani evidence za 7 dní.");
  } else {
    if (a.therapeutic_messages_7d >= 5) reasons.push("Dostatečná message sample.");
    else reasons.push(`Malá message sample (${a.therapeutic_messages_7d}).`);

    if (a.tasks.length >= 2) reasons.push("Task signál přítomný.");
    else reasons.push("Slabý task signál.");

    if (a.obs.length >= 1) reasons.push(`${a.obs.length} therapist observací.`);

    const msgWeight = Math.min(0.4, a.therapeutic_messages_7d * 0.04);
    const taskWeight = Math.min(0.3, a.tasks.length * 0.05);
    const evidenceWeight = Math.min(0.2, (a.obs.length + a.impl.length) * 0.03);
    const recencyWeight = recentness === "active_today" ? 0.1
      : recentness === "active_week" ? 0.07
      : 0;
    confidenceOverall = +(msgWeight + taskWeight + evidenceWeight + recencyWeight).toFixed(3);
  }

  return {
    therapist: a.therapist,
    activity: {
      therapeutic_messages_24h: a.therapeutic_messages_24h,
      therapeutic_messages_7d: a.therapeutic_messages_7d,
      last_therapeutic_at: a.last_therapeutic_at,
      recentness,
    },
    signal_quality: {
      score: qualityScore,
      rationale: qualityRationale,
      sample_size,
    },
    support_need: {
      level: supportLevel,
      rationale: supportRationale,
      indicators,
    },
    continuity: {
      score: continuityScore,
      open_tasks: openTasks,
      completed_tasks_7d: completedTasks7d,
      rationale: continuityRationale,
    },
    confidence: {
      overall: confidenceOverall,
      reasons,
      insufficient_data: insufficient,
    },
    source_window: { from: a.from, to: a.to },
    source_counts: {
      observations: a.obs.length,
      implications: a.impl.length,
      tasks: a.tasks.length,
      therapeutic_messages: a.therapeutic_messages_7d,
      crises_owned: a.crises.length,
    },
  };
}

// ── Public entry ──

export interface TherapistIntelligenceFoundationOutput {
  version: string;
  generated_at: string;
  notice: string;
  hanka: TherapistState;
  kata: TherapistState;
  routing_guarantee: {
    excluded_scopes: string[];
    excluded_sources: string[];
    derived_only: true;
  };
}

export function computeTherapistIntelligenceFoundation(
  input: TherapistFoundationInput,
): TherapistIntelligenceFoundationOutput {
  return {
    version: FOUNDATION_VERSION,
    generated_at: input.now.toISOString(),
    notice:
      "Therapist Intelligence Foundation is a derived operational layer. " +
      "It reads ONLY from therapeutic_team-classified data + evidence + tasks + crisis. " +
      "partner_personal and uncertain Hana content is firewalled out by construction.",
    hanka: computeHanka(input),
    kata: computeKata(input),
    routing_guarantee: {
      excluded_scopes: ["partner_personal", "uncertain"],
      excluded_sources: ["karel_episodes (HANA private)", "drive raw content"],
      derived_only: true,
    },
  };
}
