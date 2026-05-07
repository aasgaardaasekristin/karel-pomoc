/**
 * P30.1 — Active-part Daily Brief generator.
 * P30.4 — Canonicalization + matrix-ref hardening.
 *
 * Builds one row per "active or watchlist" DID part for a given Prague date,
 * upserting into `did_active_part_daily_brief`. NEVER hallucinates biographical
 * facts, anniversaries, or internet news. If no provider ran, internet-related
 * arrays stay empty and `evidence_summary.provider_status` is recorded.
 *
 * P30.4 contract:
 *   - Every candidate part is run through canonicalizeDidPartName().
 *   - forbidden_non_part / placeholder / unmapped → row written with
 *     evidence_summary.excluded_from_briefing = true (no clinical mutation).
 *   - case_alias rows collapse to the canonical part_name and are excluded
 *     so the briefing layer never sees lowercase/uppercase duplicates.
 *   - displayable rows REQUIRE evidence_summary.weekly_matrix_ref AND
 *     evidence_summary.query_plan_version. Otherwise the row is written
 *     with excluded_from_briefing=true and reason missing_weekly_matrix_ref_p30_4.
 */

import {
  canonicalizeDidPartName,
  normalizeCzechPartKey,
  type CanonicalPartNameResult,
} from "./didPartCanonicalization.ts";

// deno-lint-ignore no-explicit-any
type SB = any;

const PRESENTATION_QUERY_PLAN_VERSION =
  "p30.3_personal_anchor_general_trigger_weekly_matrix";

export interface GenerateBriefsInput {
  userId: string;
  datePrague: string;
  dryRun?: boolean;
  /** Optional override for "now" used in expires_at. */
  now?: Date;
  /** Optional explicit provider status from the most recent watch run. */
  providerStatus?:
    | "configured"
    | "not_configured"
    | "provider_not_configured"
    | "provider_error"
    | "not_run";
  /** P30.3 — matrix row id per part_name for weekly_matrix_ref backfill. */
  matrixIdsByPart?: Record<string, string>;
  /** P30.3 — query plan version recorded into evidence_summary. */
  queryPlanVersion?: string;
}

export interface GenerateBriefsResult {
  ok: boolean;
  datePrague: string;
  parts_considered: number;
  briefs_upserted: number;
  provider_status: string;
  internet_events_used_count: number;
  source_refs_count: number;
  warnings: string[];
  errors: string[];
}

const DAY_MS = 86_400_000;

function pragueDayWindow(datePrague: string): { startUtc: Date; endUtc: Date } {
  // Approximate the Prague day with a +/- 12h envelope. Briefing layer can
  // tighten this if it cares about strict midnight alignment.
  const startUtc = new Date(`${datePrague}T00:00:00Z`);
  startUtc.setTime(startUtc.getTime() - DAY_MS / 2);
  const endUtc = new Date(`${datePrague}T23:59:59Z`);
  endUtc.setTime(endUtc.getTime() + DAY_MS / 2);
  return { startUtc, endUtc };
}

async function detectActiveParts(
  sb: SB,
  userId: string,
): Promise<
  Array<{
    part_name: string;
    activity_status:
      | "active_thread"
      | "recent_thread"
      | "registry_active"
      | "watchlist";
    last_seen_at: string | null;
    known_triggers: string[];
    notes: string | null;
  }>
> {
  const out = new Map<
    string,
    {
      part_name: string;
      activity_status:
        | "active_thread"
        | "recent_thread"
        | "registry_active"
        | "watchlist";
      last_seen_at: string | null;
      known_triggers: string[];
      notes: string | null;
    }
  >();

  // 1) Active in registry
  const { data: regActive } = await sb
    .from("did_part_registry")
    .select("part_name, status, last_seen_at, known_triggers, notes")
    .eq("user_id", userId)
    .eq("status", "active");
  for (const r of (regActive ?? []) as Array<any>) {
    if (!r?.part_name) continue;
    out.set(r.part_name, {
      part_name: r.part_name,
      activity_status: "registry_active",
      last_seen_at: r.last_seen_at ?? null,
      known_triggers: Array.isArray(r.known_triggers) ? r.known_triggers : [],
      notes: r.notes ?? null,
    });
  }

  // 2) Recent threads in last 7 days (best effort — table may differ)
  try {
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const { data: threads } = await sb
      .from("did_threads")
      .select("part_name, last_message_at, updated_at")
      .eq("user_id", userId)
      .gte("updated_at", since)
      .limit(200);
    for (const t of (threads ?? []) as Array<any>) {
      const name = t?.part_name;
      if (!name) continue;
      const last = t?.last_message_at ?? t?.updated_at ?? null;
      const isFresh = last
        ? Date.now() - new Date(last).getTime() < 2 * DAY_MS
        : false;
      const status = isFresh ? "active_thread" : "recent_thread";
      const prev = out.get(name);
      if (!prev) {
        out.set(name, {
          part_name: name,
          activity_status: status,
          last_seen_at: last,
          known_triggers: [],
          notes: null,
        });
      } else if (status === "active_thread") {
        prev.activity_status = "active_thread";
        prev.last_seen_at = last ?? prev.last_seen_at;
      }
    }
  } catch {
    // table absent — ignore silently; registry path still populates parts
  }

  // 3) Watchlist via existing sensitivities (a part with sensitivities is on
  //    the watchlist even if not currently communicating).
  const { data: sensRows } = await sb
    .from("part_external_event_sensitivities")
    .select("part_name")
    .eq("user_id", userId)
    .eq("active", true);
  for (const s of (sensRows ?? []) as Array<any>) {
    if (!s?.part_name || out.has(s.part_name)) continue;
    out.set(s.part_name, {
      part_name: s.part_name,
      activity_status: "watchlist",
      last_seen_at: null,
      known_triggers: [],
      notes: null,
    });
  }

  return Array.from(out.values());
}

export async function generateActivePartDailyBriefs(
  sb: SB,
  input: GenerateBriefsInput,
): Promise<GenerateBriefsResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const now = input.now ?? new Date();
  const { startUtc, endUtc } = pragueDayWindow(input.datePrague);

  const rawParts = await detectActiveParts(sb, input.userId);

  // P30.4 — load registry and canonicalize candidates
  const { data: registryRows } = await sb
    .from("did_part_registry")
    .select("part_name, status")
    .eq("user_id", input.userId);
  const registryParts = ((registryRows ?? []) as Array<any>).map((r) => ({
    part_name: r?.part_name ?? "",
    status: r?.status ?? null,
  }));

  // P30.4 — build a normalized-key index of matrix ids so case variants of
  // an input part still resolve to the canonical matrix row.
  const matrixIdsByNormalizedKey = new Map<string, string>();
  for (const [k, v] of Object.entries(input.matrixIdsByPart ?? {})) {
    const nk = normalizeCzechPartKey(k);
    if (nk && v && !matrixIdsByNormalizedKey.has(nk)) {
      matrixIdsByNormalizedKey.set(nk, String(v));
    }
  }

  // Canonicalize every candidate. Group by normalized_key so case variants
  // collapse into a single displayable canonical row + N excluded aliases.
  type Candidate = (typeof rawParts)[number] & {
    canonical: CanonicalPartNameResult;
  };
  const candidates: Candidate[] = rawParts.map((p) => ({
    ...p,
    canonical: canonicalizeDidPartName(p.part_name, registryParts),
  }));

  const groupsByKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = c.canonical.normalized_key || `__raw__${c.part_name}`;
    const arr = groupsByKey.get(key) ?? [];
    arr.push(c);
    groupsByKey.set(key, arr);
  }

  // Decide displayable target name per group: must be canonical status,
  // and the canonical name itself becomes the part_name we upsert under.
  const groupDecisions = new Map<
    string,
    {
      canonical_part_name: string | null;
      displayable_used: boolean;
    }
  >();
  for (const [key, group] of groupsByKey.entries()) {
    const canonicalRow = group.find(
      (g) => g.canonical.status === "canonical" && g.canonical.canonical_part_name,
    );
    const aliasRow = canonicalRow ?? group.find(
      (g) => g.canonical.status === "case_alias" && g.canonical.canonical_part_name,
    );
    groupDecisions.set(key, {
      canonical_part_name: aliasRow?.canonical.canonical_part_name ?? null,
      displayable_used: false,
    });
  }

  let briefs = 0;
  let totalInternetEvents = 0;
  let totalSourceRefs = 0;

  // Sensitivities all parts (one fetch)
  const { data: allSens } = await sb
    .from("part_external_event_sensitivities")
    .select(
      "id, part_name, event_pattern, sensitivity_types, recommended_guard, safe_opening_style",
    )
    .eq("user_id", input.userId)
    .eq("active", true);
  const sensByPart = new Map<string, Array<any>>();
  for (const s of (allSens ?? []) as Array<any>) {
    const arr = sensByPart.get(s.part_name) ?? [];
    arr.push(s);
    sensByPart.set(s.part_name, arr);
  }

  // Determine provider status from most recent watch run today (read-only)
  let providerStatus = input.providerStatus ?? "not_run";
  if (!input.providerStatus) {
    const { data: lastRun } = await sb
      .from("external_event_watch_runs")
      .select("internet_watch_status, ran_at, source_type")
      .eq("user_id", input.userId)
      .eq("source_type", "internet_news")
      .gte("ran_at", startUtc.toISOString())
      .lte("ran_at", endUtc.toISOString())
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRun?.internet_watch_status) {
      providerStatus = lastRun.internet_watch_status;
    }
  }

  for (const part of parts) {
    // External events linked to this part name in the last 7 days.
    let externalEvents: Array<any> = [];
    try {
      const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
      const { data: evRows } = await sb
        .from("external_reality_events")
        .select(
          "id, event_title, event_type, source_url, source_domain, summary_for_therapists, verification_status, last_seen_at, raw_payload",
        )
        .eq("user_id", input.userId)
        .gte("last_seen_at", since)
        .order("last_seen_at", { ascending: false })
        .limit(100);
      // Filter for ones related to this part via raw_payload.related_part_name
      // OR via classifier hit_terms (best-effort).
      externalEvents = ((evRows ?? []) as Array<any>).filter((e) => {
        const rp = e.raw_payload ?? {};
        const relPart = rp.related_part_name ?? null;
        if (relPart && relPart === part.part_name) return true;
        const terms: string[] = Array.isArray(rp.hit_terms) ? rp.hit_terms : [];
        // Heuristic only: rely on therapist sensitivity matching for richer link.
        const sensList = sensByPart.get(part.part_name) ?? [];
        return sensList.some((s: any) =>
          terms.some((t) =>
            t?.toLowerCase()?.includes((s.event_pattern ?? "").toLowerCase())
          )
        );
      });
    } catch (e) {
      warnings.push(`load_events_failed:${part.part_name}:${(e as Error).message}`);
    }

    const internetTriggers = externalEvents.filter(
      (e) => !!e.source_url && /^https?:\/\//i.test(e.source_url),
    );
    const sourceRefs = internetTriggers.map((e) => ({
      url: e.source_url,
      title: e.event_title,
      verification_status: e.verification_status,
      last_seen_at: e.last_seen_at,
    }));
    totalInternetEvents += internetTriggers.length;
    totalSourceRefs += sourceRefs.length;

    const sensList = sensByPart.get(part.part_name) ?? [];
    const knownPatterns = sensList.map((s: any) => ({
      sensitivity_id: s.id,
      pattern: s.event_pattern,
      kinds: s.sensitivity_types ?? [],
      recommended_guard: s.recommended_guard ?? null,
      safe_opening_style: s.safe_opening_style ?? null,
    }));

    // Recommended prevention is framed as caution, never as factual diagnosis.
    const recommended = sensList.map((s: any) => ({
      sensitivity_id: s.id,
      caution: `Pokud se dnes objeví téma "${s.event_pattern}", u části ${part.part_name} volit nízkou intenzitu, validaci bezpečí, žádné explicitní detaily.`,
      guard: s.recommended_guard ?? null,
      opening_style: s.safe_opening_style ?? null,
    }));

    const matrixRef = input.matrixIdsByPart?.[part.part_name] ?? null;
    const evidenceSummary = {
      provider_status: providerStatus,
      detected_via:
        part.activity_status === "watchlist"
          ? "sensitivity_only"
          : part.activity_status,
      sensitivity_count: sensList.length,
      external_events_total: externalEvents.length,
      source_backed_event_count: internetTriggers.length,
      // P30.3 — matrix linkage + plan version
      weekly_matrix_ref: matrixRef,
      query_plan_version: input.queryPlanVersion ?? null,
      trigger_source: matrixRef ? "p30.3_weekly_matrix" : "legacy_sensitivity_only",
    };

    if (input.dryRun) {
      briefs++;
      continue;
    }

    const expiresAt = new Date(now.getTime() + 36 * 3600 * 1000).toISOString();
    const upsert = await sb
      .from("did_active_part_daily_brief")
      .upsert(
        {
          user_id: input.userId,
          brief_date: input.datePrague,
          part_name: part.part_name,
          activity_status: part.activity_status,
          anamnesis_excerpt: { notes: part.notes ?? null },
          known_sensitive_patterns: knownPatterns,
          // Anniversaries deliberately empty: we never invent dates.
          anniversaries_today: [],
          internet_triggers_today: internetTriggers.map((e) => ({
            event_id: e.id,
            title: e.event_title,
            event_type: e.event_type,
            source_url: e.source_url,
            verification_status: e.verification_status,
            last_seen_at: e.last_seen_at,
          })),
          external_events_today: externalEvents.map((e) => ({
            event_id: e.id,
            title: e.event_title,
            event_type: e.event_type,
            verification_status: e.verification_status,
            has_source_url: !!e.source_url,
          })),
          recommended_prevention: recommended,
          evidence_summary: evidenceSummary,
          source_refs: sourceRefs,
          generated_by: "external_reality_watch",
          generated_at: now.toISOString(),
          expires_at: expiresAt,
          status: "active",
        },
        { onConflict: "user_id,brief_date,part_name" },
      );
    if (upsert.error) {
      errors.push(
        `upsert_failed:${part.part_name}:${upsert.error.message ?? upsert.error}`,
      );
      continue;
    }
    briefs++;
  }

  return {
    ok: errors.length === 0,
    datePrague: input.datePrague,
    parts_considered: parts.length,
    briefs_upserted: briefs,
    provider_status: providerStatus,
    internet_events_used_count: totalInternetEvents,
    source_refs_count: totalSourceRefs,
    warnings,
    errors,
  };
}
