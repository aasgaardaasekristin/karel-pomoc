/**
 * P7: External Reality Sentinel
 *
 * Ingestion + classifier for external real-world events that may emotionally
 * affect DID parts. Routes signals from:
 *   - therapist_report  (text from Hanka/Káťa anywhere — thread, deliberation, task note)
 *   - child_part_mention (text from a child-part / kluci channel)
 *   - calendar_anniversary (date-bound triggers)
 *   - internet_news      (NOT IMPLEMENTED — flagged explicitly)
 *
 * Outputs:
 *   - external_reality_events
 *   - external_event_impacts (linked to part_external_event_sensitivities)
 *   - external_event_watch_runs (audit log)
 *   - did_therapist_tasks ("verify exposure" task)
 *
 * SAFETY RULES (HARD):
 *   - never store raw graphic content for child-facing UI
 *   - never confirm part identity as a real person ("Arthur is Arthur Labinjo-Hughes" → forbidden)
 *   - never invent a verified internet source — if no API, set internet_watch_status='not_implemented'
 *
 * Body:
 *   {
 *     action: "ingest_text" | "calendar_check" | "internet_watch" | "list_impacts",
 *     source_type?: "therapist_report" | "child_part_mention" | "calendar" | "internet_news",
 *     text?: string,
 *     reporter?: "hanka" | "kata" | "kluci" | "system",
 *     event_date?: string (YYYY-MM-DD)
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";
import {
  assertCanonicalDidScopeOrThrow,
  CanonicalUserScopeError,
} from "../_shared/canonicalUserScopeGuard.ts";
import {
  detectProviderFromEnv,
  runExternalRealitySearchProvider,
} from "../_shared/externalRealitySearchProvider.ts";
import { normalizeExternalSearchResultToEvent } from "../_shared/externalRealityEvents.ts";
import { generateActivePartDailyBriefs } from "../_shared/activePartDailyBrief.ts";
import { runP303ExternalRealityPipeline } from "../_shared/externalRealityP303Orchestrator.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight regex classifier (no AI dependency for the first slice).
// AI enrichment can be layered later via Lovable AI Gateway.
// Czech diacritics are encoded as Unicode escapes per project rule.
// ─────────────────────────────────────────────────────────────────────────────

interface ClassifierHit {
  event_type: string;
  graphic_content_risk: "low" | "medium" | "high";
  child_exposure_risk: "low" | "medium" | "high";
  matched_terms: string[];
  triggers_real_event: boolean;
}

const REAL_EVENT_HINTS = [
  /skute\u010Dn[\u00E9\u00FD]/i, /re\u00E1ln[\u00E9\u00FD]/i, /\u010Dl\u00E1nek/i,
  /zpr\u00E1va/i, /internet/i, /p\u0159\u00EDpad/i, /soud/i, /\bnews\b/i,
  /\bvideo\b/i, /\bm\u00E9di/i, /TV/i, /tisk/i,
];

const PATTERNS: Array<{
  re: RegExp;
  event_type: string;
  graphic: "low" | "medium" | "high";
  child: "low" | "medium" | "high";
  term: string;
}> = [
  // Animal suffering / rescue
  { re: /velryb/i, event_type: "animal_suffering", graphic: "medium", child: "high", term: "velryba" },
  { re: /\bTimm[yi](?:[a-z\u00E0-\u017E]{0,3})?\b/i, event_type: "animal_suffering", graphic: "medium", child: "high", term: "Timmy" },
  { re: /t[\u00FDy]r[\u00E1a]n[\u00ED] zv[\u00ED]\u0159at/i, event_type: "animal_suffering", graphic: "high", child: "high", term: "t\u00FDr\u00E1n\u00ED zv\u00ED\u0159at" },
  { re: /rescue/i, event_type: "rescue_failure", graphic: "low", child: "medium", term: "rescue" },
  // Child abuse
  { re: /Arthur Labinjo-Hughes/i, event_type: "child_abuse", graphic: "high", child: "high", term: "Arthur Labinjo-Hughes" },
  { re: /t[\u00FDy]r[\u00E1a]n[\u00ED] d[\u00ED]t[\u011Be]/i, event_type: "child_abuse", graphic: "high", child: "high", term: "t\u00FDr\u00E1n\u00ED d\u00EDt\u011Bte" },
  { re: /vra\u017Eda d[\u00ED]t[\u011Be]/i, event_type: "child_abuse", graphic: "high", child: "high", term: "vra\u017Eda d\u00EDt\u011Bte" },
  { re: /child abuse/i, event_type: "child_abuse", graphic: "high", child: "high", term: "child abuse" },
  // Other heavy
  { re: /v\u00E1lka|\bwar\b/i, event_type: "war", graphic: "medium", child: "high", term: "v\u00E1lka" },
  { re: /katastrof|disaster/i, event_type: "disaster", graphic: "medium", child: "high", term: "katastrofa" },
  { re: /\bsmrt\b|\bdeath\b|\u00FAmrt[\u00ED\u00ED]/i, event_type: "death", graphic: "medium", child: "high", term: "smrt" },
];

function classifyText(text: string): ClassifierHit[] {
  if (!text || typeof text !== "string") return [];
  const hits: ClassifierHit[] = [];
  const triggersReal = REAL_EVENT_HINTS.some((re) => re.test(text));
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      const key = `${p.event_type}:${p.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        event_type: p.event_type,
        graphic_content_risk: p.graphic,
        child_exposure_risk: p.child,
        matched_terms: [p.term],
        triggers_real_event: triggersReal,
      });
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Match hits to part sensitivities → impact rows
// ─────────────────────────────────────────────────────────────────────────────

interface SensitivityRow {
  id: string;
  user_id: string;
  part_name: string;
  event_pattern: string;
  sensitivity_types: string[];
  recommended_guard: string | null;
  safe_opening_style: string | null;
}

function deriveRiskLevel(
  hit: ClassifierHit,
  sensitivity: SensitivityRow,
  reporter: string,
): "watch" | "amber" | "red" {
  // Therapist explicitly reports impact → at least amber
  if (reporter === "hanka" || reporter === "kata") {
    if (hit.graphic_content_risk === "high" || hit.child_exposure_risk === "high") return "red";
    return "amber";
  }
  // child mention of explicitly graphic content → red
  if (reporter === "kluci" && hit.child_exposure_risk === "high") return "red";
  if (hit.child_exposure_risk === "high") return "amber";
  return "watch";
}

function safeSummary(hit: ClassifierHit, reporter: string, snippet: string): string {
  // NEVER store raw snippet for high-graphic cases
  const safe = hit.graphic_content_risk === "high"
    ? "[Obsah neuložen – vysoké riziko grafického materiálu. Pouze terapeutický popis.]"
    : snippet.slice(0, 280);
  return `Zdroj: ${reporter}. Téma: ${hit.matched_terms.join(", ")}. ${safe}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function ingestText(
  admin: ReturnType<typeof createClient>,
  userId: string,
  body: { text?: string; source_type?: string; reporter?: string; event_date?: string },
): Promise<{ events_created: number; impacts_created: number; tasks_created: number; warnings: string[] }> {
  const text = String(body.text ?? "").trim();
  const sourceType = String(body.source_type ?? "therapist_report");
  const reporter = String(body.reporter ?? "system");
  const warnings: string[] = [];

  if (!text) return { events_created: 0, impacts_created: 0, tasks_created: 0, warnings: ["empty_text"] };
  if (!["therapist_report", "child_part_mention", "calendar"].includes(sourceType)) {
    return { events_created: 0, impacts_created: 0, tasks_created: 0, warnings: ["invalid_source_type"] };
  }

  const hits = classifyText(text);
  if (hits.length === 0) {
    return { events_created: 0, impacts_created: 0, tasks_created: 0, warnings: ["no_classifier_match"] };
  }

  // Load all sensitivities for canonical user
  const { data: sensRows } = await admin
    .from("part_external_event_sensitivities")
    .select("id, user_id, part_name, event_pattern, sensitivity_types, recommended_guard, safe_opening_style")
    .eq("user_id", userId)
    .eq("active", true);
  const sensitivities = (sensRows ?? []) as SensitivityRow[];

  let events_created = 0;
  let impacts_created = 0;
  let tasks_created = 0;

  for (const hit of hits) {
    // Insert event
    const verification = reporter === "hanka" || reporter === "kata"
      ? "therapist_confirmed"
      : "unverified";
    const { data: ev, error: evErr } = await admin
      .from("external_reality_events")
      .insert({
        user_id: userId,
        event_title: hit.matched_terms.join(", "),
        event_type: hit.event_type,
        source_type: sourceType,
        verification_status: verification,
        graphic_content_risk: hit.graphic_content_risk,
        child_exposure_risk: hit.child_exposure_risk,
        summary_for_therapists: safeSummary(hit, reporter, text),
        do_not_show_child_text: hit.child_exposure_risk !== "low" || hit.graphic_content_risk !== "low",
        event_date: body.event_date ?? null,
        raw_payload: { reporter, hit_terms: hit.matched_terms, triggers_real_event: hit.triggers_real_event },
      })
      .select("id")
      .single();
    if (evErr) {
      warnings.push(`event_insert_failed:${evErr.message}`);
      continue;
    }
    events_created++;
    const eventId = ev?.id as string;

    // Match against sensitivities
    const matchedSens = sensitivities.filter((s) =>
      hit.matched_terms.some((t) => t.toLowerCase().includes(s.event_pattern.toLowerCase())) ||
      s.event_pattern.toLowerCase().includes(hit.matched_terms[0]?.toLowerCase() ?? "") ||
      s.sensitivity_types.includes(hit.event_type)
    );

    if (matchedSens.length === 0) {
      // generic "watch" impact for unknown parts
      await admin.from("external_event_impacts").insert({
        user_id: userId,
        event_id: eventId,
        part_name: "(neidentifikovaná část)",
        risk_level: "watch",
        reason: "Klasifikováno jako externí realita, ale žádná část neodpovídá vzoru.",
        recommended_action: "Ověřit, zda téma rezonuje s některou částí.",
      });
      impacts_created++;
      continue;
    }

    for (const sens of matchedSens) {
      const risk = deriveRiskLevel(hit, sens, reporter);
      const recommended = [
        sens.safe_opening_style ?? "Nízkoprahový check tělo/emoce/bezpečí.",
        sens.recommended_guard ?? "",
      ].filter(Boolean).join(" ");

      // P11 dedupe guard: skip insert if an unacknowledged impact already exists
      // for the same (user_id, part_name, theme cluster ≈ event_type). This prevents
      // the post-P10 drift where every ingest_text re-created a parallel impact row
      // for the same clinical theme (e.g. Tundrupek + animal_suffering).
      const { data: existingActive } = await admin
        .from("external_event_impacts")
        .select("id, event_id, external_reality_events!inner(event_type)")
        .eq("user_id", userId)
        .eq("part_name", sens.part_name)
        .is("acknowledged_at", null)
        .is("resolved_at", null)
        .eq("external_reality_events.event_type", hit.event_type)
        .limit(1);
      if (existingActive && existingActive.length > 0) {
        warnings.push(`p11_dedupe_skip:${sens.part_name}:${hit.event_type}`);
        continue;
      }

      await admin.from("external_event_impacts").insert({
        user_id: userId,
        event_id: eventId,
        part_name: sens.part_name,
        risk_level: risk,
        reason: `Část ${sens.part_name} má citlivost na vzor "${sens.event_pattern}" (typy: ${sens.sensitivity_types.join(", ")}).`,
        recommended_action: recommended,
      });
      impacts_created++;

      // Create therapist task for amber/red and LINK it back to the impact row
      if (risk === "amber" || risk === "red") {
        try {
          const taskText = `Ověřit expozici části ${sens.part_name} k tématu "${hit.matched_terms[0]}"`;
          const noteText = `Externí realita (${sourceType}, ${reporter}): možný emoční dopad na část ${sens.part_name}. Ověřit expozici, somatickou reakci, neukazovat grafický materiál.${sens.recommended_guard ? " Pravidlo: " + sens.recommended_guard : ""}`;
          const { data: taskRow, error: taskErr } = await admin
            .from("did_therapist_tasks")
            .insert({
              user_id: userId,
              task: taskText,
              note: noteText,
              assigned_to: reporter === "kata" ? "kata" : "hanka",
              priority: risk === "red" ? "high" : "normal",
              status: "pending",
              source: "external_reality_sentinel",
              category: "external_reality",
              task_tier: "operative",
            })
            .select("id")
            .single();
          if (taskErr) {
            warnings.push(`task_insert_failed:${taskErr.message}`);
          } else if (taskRow?.id) {
            tasks_created++;
            // P7 LINKAGE — write created_task_id back into the impact row
            const { error: linkErr } = await admin
              .from("external_event_impacts")
              .update({ created_task_id: taskRow.id })
              .eq("event_id", eventId)
              .eq("part_name", sens.part_name)
              .eq("risk_level", risk)
              .is("created_task_id", null);
            if (linkErr) {
              warnings.push(`task_linkage_failed:${linkErr.message}`);
            }
          }
        } catch (e) {
          warnings.push(`task_insert_skipped:${String((e as Error).message)}`);
        }
      }
    }
  }

  // Log run
  await admin.from("external_event_watch_runs").insert({
    user_id: userId,
    source_type: sourceType,
    sources_checked: 1,
    new_events: events_created,
    matched_events: impacts_created,
    warnings_created: tasks_created,
    failures: warnings.length,
    internet_watch_status: "not_implemented",
    notes: `ingest_text by ${reporter}; hits=${hits.length}`,
    payload: { warnings, hit_count: hits.length },
  });

  // Mark sentinel pipeline as ok
  try {
    await admin.rpc("did_record_slo_run", {
      p_pipeline_name: "external_reality_watch",
      p_status: "ok",
      p_evidence: { events_created, impacts_created, tasks_created, source: sourceType },
      p_evidence_ref: `ingest:${reporter}`,
      p_next_action: null,
    });
  } catch { /* swallow */ }

  return { events_created, impacts_created, tasks_created, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// P30.1 — Source-truth internet watch.
// HARD: never invent a verified internet source. If no provider is configured
// the run row records provider_not_configured and zero events are created.
// ─────────────────────────────────────────────────────────────────────────────

interface InternetWatchInput {
  date?: string;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  recencyDays?: number;
  dryRun?: boolean;
}

interface InternetWatchResult {
  status:
    | "configured"
    | "provider_not_configured"
    | "provider_error";
  provider: string | null;
  watch_run_id: string | null;
  queries_run: number;
  raw_results_count: number;
  events_created: number;
  events_deduped: number;
  source_backed_events_count: number;
  reason?: string;
  warnings: string[];
}

async function internetWatchSlice(
  admin: ReturnType<typeof createClient>,
  userId: string,
  input: InternetWatchInput,
): Promise<InternetWatchResult> {
  const warnings: string[] = [];
  const maxQueries = Math.max(1, Math.min(20, input.maxQueries ?? 10));
  const maxResultsPerQuery = Math.max(
    1,
    Math.min(10, input.maxResultsPerQuery ?? 5),
  );
  const recencyDays = Math.max(1, Math.min(30, input.recencyDays ?? 7));
  const dryRun = input.dryRun === true;

  const { data: sensRows } = await admin
    .from("part_external_event_sensitivities")
    .select("id, part_name, event_pattern, sensitivity_types")
    .eq("user_id", userId)
    .eq("active", true);
  const sens = (sensRows ?? []) as Array<{
    id: string;
    part_name: string;
    event_pattern: string;
    sensitivity_types: string[];
  }>;

  const queries: Array<{
    query: string;
    sensitivity_id: string;
    part_name: string;
    sensitivity_kind: string;
  }> = [];
  for (const s of sens) {
    const kind = s.sensitivity_types?.[0] ?? "other";
    queries.push({
      query: `${s.event_pattern} aktuální zpráva`,
      sensitivity_id: s.id,
      part_name: s.part_name,
      sensitivity_kind: kind,
    });
    if (queries.length >= maxQueries) break;
  }

  const providerInfo = detectProviderFromEnv();

  if (queries.length === 0) {
    const { data: runRow } = await admin
      .from("external_event_watch_runs")
      .insert({
        user_id: userId,
        source_type: "internet_news",
        sources_checked: 0,
        new_events: 0,
        matched_events: 0,
        warnings_created: 0,
        failures: 0,
        internet_watch_status: providerInfo.provider
          ? "configured"
          : "provider_not_configured",
        notes:
          "Internet watch: no active part sensitivities — nothing to query.",
        payload: { reason: "no_sensitivities", provider: providerInfo.provider },
      })
      .select("id")
      .single();
    return {
      status: providerInfo.provider ? "configured" : "provider_not_configured",
      provider: providerInfo.provider,
      watch_run_id: runRow?.id ?? null,
      queries_run: 0,
      raw_results_count: 0,
      events_created: 0,
      events_deduped: 0,
      source_backed_events_count: 0,
      reason: "no_sensitivities",
      warnings,
    };
  }

  const providerResp = await runExternalRealitySearchProvider({
    queries: queries.map((q) => q.query),
    maxResultsPerQuery,
    recencyDays,
  });

  if (providerResp.status === "not_configured") {
    const { data: runRow } = await admin
      .from("external_event_watch_runs")
      .insert({
        user_id: userId,
        source_type: "internet_news",
        sources_checked: queries.length,
        new_events: 0,
        matched_events: 0,
        warnings_created: 0,
        failures: 0,
        internet_watch_status: "provider_not_configured",
        notes: "no_external_search_provider_configured",
        payload: {
          reason: "no_external_search_provider_configured",
          queries: queries.map((q) => q.query),
        },
      })
      .select("id")
      .single();
    return {
      status: "provider_not_configured",
      provider: null,
      watch_run_id: runRow?.id ?? null,
      queries_run: queries.length,
      raw_results_count: 0,
      events_created: 0,
      events_deduped: 0,
      source_backed_events_count: 0,
      reason: "no_external_search_provider_configured",
      warnings,
    };
  }

  if (!providerResp.ok || providerResp.status === "error") {
    const { data: runRow } = await admin
      .from("external_event_watch_runs")
      .insert({
        user_id: userId,
        source_type: "internet_news",
        sources_checked: queries.length,
        new_events: 0,
        matched_events: 0,
        warnings_created: 0,
        failures: 1,
        internet_watch_status: "provider_error",
        notes:
          `provider_error:${providerResp.raw_error ?? providerResp.reason ?? "unknown"}`
            .slice(0, 480),
        payload: {
          provider: providerResp.provider,
          reason: providerResp.reason,
          raw_error: providerResp.raw_error,
          queries: queries.map((q) => q.query),
        },
      })
      .select("id")
      .single();
    return {
      status: "provider_error",
      provider: providerResp.provider,
      watch_run_id: runRow?.id ?? null,
      queries_run: queries.length,
      raw_results_count: 0,
      events_created: 0,
      events_deduped: 0,
      source_backed_events_count: 0,
      reason: providerResp.reason ?? "provider_error",
      warnings,
    };
  }

  const queryMeta = new Map(queries.map((q) => [q.query, q]));
  let eventsCreated = 0;
  let eventsDeduped = 0;
  const sourceBackedCount = providerResp.results.length;

  for (const result of providerResp.results) {
    const meta = queryMeta.get(result.query);
    if (!meta) continue;
    const sensRow = sens.find((s) => s.id === meta.sensitivity_id);
    if (!sensRow) continue;

    const inferredType = sensRow.sensitivity_types?.[0] ?? "other";
    const allowedTypes = new Set([
      "animal_suffering",
      "child_abuse",
      "public_trial",
      "disaster",
      "war",
      "rescue_failure",
      "death",
      "anniversary",
      "other",
    ]);
    const safeType = allowedTypes.has(inferredType) ? inferredType : "other";

    const normalized = await normalizeExternalSearchResultToEvent(result, {
      partName: meta.part_name,
      sensitivityId: meta.sensitivity_id,
      sensitivityKind: meta.sensitivity_kind,
      inferredEventType: safeType,
      childExposureRisk: "high",
      graphicContentRisk: "medium",
      aiSummarized: providerResp.provider === "perplexity",
    });

    const { data: existing } = await admin
      .from("external_reality_events")
      .select("id")
      .eq("user_id", userId)
      .eq("source_url", normalized.source_url)
      .limit(1);
    if (existing && existing.length > 0) {
      eventsDeduped++;
      if (!dryRun) {
        await admin
          .from("external_reality_events")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", existing[0].id);
      }
      continue;
    }

    if (dryRun) {
      eventsCreated++;
      continue;
    }

    const { error: insErr } = await admin
      .from("external_reality_events")
      .insert({
        user_id: userId,
        event_title: normalized.event_title,
        event_type: normalized.event_type,
        source_type: "internet_news",
        source_url: normalized.source_url,
        source_domain: normalized.source_name,
        source_reliability: "unknown",
        // P30.1 maps source-truth states onto the existing DB enum: anything
        // automated stays at "single_source" until a therapist verifies it.
        verification_status: "single_source",
        graphic_content_risk: normalized.graphic_content_risk,
        child_exposure_risk: normalized.child_exposure_risk,
        summary_for_therapists: normalized.event_summary,
        do_not_show_child_text: true,
        raw_payload: {
          provider: normalized.provider,
          search_query: normalized.search_query,
          related_part_name: normalized.related_part_name,
          related_sensitivity_id: normalized.related_sensitivity_id,
          sensitivity_kind: normalized.sensitivity_kind,
          dedupe_key: normalized.dedupe_key,
          semantic_dedupe_key: normalized.semantic_dedupe_key,
          source_backed_verification_status: normalized.verification_status,
          fetched_at: normalized.fetched_at,
          source_published_at: normalized.source_published_at,
        },
      });
    if (insErr) {
      warnings.push(`insert_event_failed:${insErr.message?.slice(0, 120)}`);
      continue;
    }
    eventsCreated++;
  }

  const { data: runRow } = await admin
    .from("external_event_watch_runs")
    .insert({
      user_id: userId,
      source_type: "internet_news",
      sources_checked: queries.length,
      new_events: eventsCreated,
      matched_events: eventsCreated,
      warnings_created: 0,
      failures: warnings.length,
      internet_watch_status: "configured",
      notes:
        `provider=${providerResp.provider} created=${eventsCreated} deduped=${eventsDeduped}`,
      payload: {
        provider: providerResp.provider,
        queries: queries.map((q) => q.query),
        raw_results_count: providerResp.results.length,
        events_deduped: eventsDeduped,
        warnings,
      },
    })
    .select("id")
    .single();

  try {
    await admin.rpc("did_record_slo_run", {
      p_pipeline_name: "external_reality_watch",
      p_status: "ok",
      p_evidence: {
        events_created: eventsCreated,
        events_deduped: eventsDeduped,
        provider: providerResp.provider,
      },
      p_evidence_ref: `internet_watch:${providerResp.provider}`,
      p_next_action: null,
    });
  } catch { /* swallow */ }

  return {
    status: "configured",
    provider: providerResp.provider,
    watch_run_id: runRow?.id ?? null,
    queries_run: queries.length,
    raw_results_count: providerResp.results.length,
    events_created: eventsCreated,
    events_deduped: eventsDeduped,
    source_backed_events_count: sourceBackedCount,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P9: Self-healing guard — repair dangling created_task_id on active amber/red
// impacts. Only touches active impacts, never resolves them, never invents data.
// ─────────────────────────────────────────────────────────────────────────────

interface DanglingRepairResult {
  dangling_detected: number;
  tasks_recreated: number;
  relinked_impact_ids: string[];
  warnings: string[];
}

async function repairDanglingTaskLinkages(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<DanglingRepairResult> {
  const result: DanglingRepairResult = {
    dangling_detected: 0,
    tasks_recreated: 0,
    relinked_impact_ids: [],
    warnings: [],
  };

  // 1) Load active amber/red impacts with a created_task_id
  const { data: impacts, error: impactsErr } = await admin
    .from("external_event_impacts")
    .select("id, event_id, part_name, risk_level, recommended_action, created_task_id")
    .eq("user_id", userId)
    .is("resolved_at", null)
    .is("acknowledged_at", null)
    .in("risk_level", ["amber", "red"])
    .not("created_task_id", "is", null);
  if (impactsErr) {
    result.warnings.push(`load_impacts_failed:${impactsErr.message}`);
    return result;
  }
  const linked = (impacts ?? []) as Array<{
    id: string; event_id: string; part_name: string; risk_level: string;
    recommended_action: string | null; created_task_id: string;
  }>;
  if (linked.length === 0) return result;

  // 2) Check which task ids actually exist
  const taskIds = Array.from(new Set(linked.map((r) => r.created_task_id)));
  const { data: existingTasks } = await admin
    .from("did_therapist_tasks")
    .select("id")
    .in("id", taskIds);
  const existing = new Set((existingTasks ?? []).map((t: { id: string }) => t.id));
  const dangling = linked.filter((r) => !existing.has(r.created_task_id));
  result.dangling_detected = dangling.length;
  if (dangling.length === 0) return result;

  // 3) Load event titles in one batch (no graphic raw text used)
  const eventIds = Array.from(new Set(dangling.map((d) => d.event_id)));
  const { data: events } = await admin
    .from("external_reality_events")
    .select("id, event_title")
    .in("id", eventIds);
  const titleMap = new Map(((events ?? []) as Array<{ id: string; event_title: string }>).map((e) => [e.id, e.event_title]));

  // 4) Recreate task + relink, idempotently per impact
  for (const d of dangling) {
    const title = titleMap.get(d.event_id) ?? "(neuvedené téma)";
    const taskText = `Ověřit expozici části ${d.part_name} k tématu "${title}" (tělo / emoce / bezpečí)`;
    const noteText = [
      `[P9_p7_relink_repair_self_healing] original_missing_task_id=${d.created_task_id}`,
      `impact_id=${d.id} | event_id=${d.event_id} | repaired_at=${new Date().toISOString()}`,
      "",
      "Klinický pokyn: ověřit somatickou reakci a pocit bezpečí. Nepředkládat grafické detaily. Nepotvrzovat identitu části jako fakt o reálné osobě.",
      d.recommended_action ?? "",
    ].filter(Boolean).join("\n");

    const { data: newTask, error: insertErr } = await admin
      .from("did_therapist_tasks")
      .insert({
        user_id: userId,
        task: taskText,
        note: noteText,
        assigned_to: "hanka",
        status: "pending",
        priority: d.risk_level === "red" ? "high" : "normal",
        category: "external_reality",
        task_tier: "operative",
        source: "external_reality_sentinel",
      })
      .select("id")
      .single();
    if (insertErr || !newTask?.id) {
      result.warnings.push(`recreate_failed:${d.id}:${insertErr?.message ?? "no_id"}`);
      continue;
    }

    const { error: relinkErr } = await admin
      .from("external_event_impacts")
      .update({ created_task_id: newTask.id })
      .eq("id", d.id);
    if (relinkErr) {
      result.warnings.push(`relink_failed:${d.id}:${relinkErr.message}`);
      continue;
    }
    result.tasks_recreated++;
    result.relinked_impact_ids.push(d.id);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP entry
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // P30.2: accept X-Karel-Cron-Secret as an internal/cron auth path so the
  // daily orchestrator can call this function without an end-user JWT.
  const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
  let isCronSecretCall = false;
  if (cronSecretHeader) {
    try {
      const { data: ok } = await admin.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
      isCronSecretCall = ok === true;
    } catch (e) {
      console.warn("[ext-reality-sentinel] cron secret rpc failed:", (e as Error).message);
    }
  }

  let canonicalUserId: string;
  if (isCronSecretCall) {
    try {
      const { data: canonicalId } = await admin.rpc("get_canonical_did_user_id");
      if (typeof canonicalId !== "string" || !canonicalId) {
        return json({ ok: false, error_code: "canonical_user_unresolved" }, 500);
      }
      canonicalUserId = canonicalId;
    } catch (e) {
      return json({ ok: false, error_code: "canonical_user_unresolved", message: String((e as Error)?.message ?? e) }, 500);
    }
  } else {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
    try {
      canonicalUserId = await assertCanonicalDidScopeOrThrow(admin as never, auth.user.id);
    } catch (err) {
      if (err instanceof CanonicalUserScopeError) {
        return json({ ok: false, error_code: err.code, message: err.message }, 403);
      }
      return json({ ok: false, error_code: "scope_check_failed", message: String(err) }, 500);
    }
  }

  let body: {
    action?: string;
    text?: string;
    source_type?: string;
    reporter?: string;
    event_date?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body" }, 400);
  }

  const action = body.action ?? "ingest_text";

  try {
    if (action === "ingest_text") {
      const result = await ingestText(admin, canonicalUserId, body);
      // P9 self-healing: opportunistic relink (non-fatal)
      const heal = await repairDanglingTaskLinkages(admin, canonicalUserId);
      return json({ ok: true, ...result, self_healing: heal });
    }
    if (action === "internet_watch") {
      const datePrague = (body as any).date ??
        new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }))
          .toISOString().slice(0, 10);
      const result = await runP303ExternalRealityPipeline(admin as any, {
        userId: canonicalUserId,
        datePrague,
        maxQueries: (body as any).maxQueries,
        maxResultsPerQuery: (body as any).maxResultsPerQuery,
        recencyDays: (body as any).recencyDays,
        dryRun: (body as any).dryRun === true,
      });
      return json({ ok: result.ok, ...result }, 200);
    }
    if (action === "generate_active_part_daily_brief") {
      const datePrague = (body as any).date ??
        new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }))
          .toISOString().slice(0, 10);
      const pipeline = await runP303ExternalRealityPipeline(admin as any, {
        userId: canonicalUserId,
        datePrague,
        maxQueries: (body as any).maxQueries,
        maxResultsPerQuery: (body as any).maxResultsPerQuery,
        recencyDays: (body as any).recencyDays,
        dryRun: (body as any).dryRun === true,
      });
      const result = await generateActivePartDailyBriefs(admin as any, {
        userId: canonicalUserId,
        datePrague,
        dryRun: (body as any).dryRun === true,
        providerStatus: pipeline.provider_status as any,
        matrixIdsByPart: pipeline.matrix_ids_by_part,
        queryPlanVersion: pipeline.query_plan_version,
      });
      return json({
        ok: result.ok,
        ...result,
        p30_3: {
          relevant_parts: pipeline.relevant_parts,
          query_plan_version: pipeline.query_plan_version,
          legacy_example_terms_blocked: pipeline.legacy_example_terms_blocked,
          matrix_rows_upserted: pipeline.matrix_rows_upserted,
          watch_run_id: pipeline.watch_run_id,
        },
      });
    }
    if (action === "relink_dangling_tasks") {
      const heal = await repairDanglingTaskLinkages(admin, canonicalUserId);
      return json({ ok: true, ...heal });
    }
    if (action === "list_impacts") {
      // P9 self-healing before listing, so consumers never see dangling links
      const heal = await repairDanglingTaskLinkages(admin, canonicalUserId);
      const { data, error } = await admin
        .from("external_event_impacts")
        .select("id, event_id, part_name, risk_level, reason, recommended_action, created_task_id, created_at, acknowledged_at, resolved_at, external_reality_events(event_title, event_type, source_type, verification_status, graphic_content_risk, summary_for_therapists)")
        .eq("user_id", canonicalUserId)
        .is("resolved_at", null)
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return json({ ok: false, message: error.message }, 500);
      return json({ ok: true, impacts: data ?? [], self_healing: heal });
    }
    return json({ ok: false, message: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ ok: false, message: String((e as Error)?.message ?? e) }, 500);
  }
});
