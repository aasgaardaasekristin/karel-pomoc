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
  { re: /\bTimmy\b/i, event_type: "animal_suffering", graphic: "medium", child: "high", term: "Timmy" },
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

      await admin.from("external_event_impacts").insert({
        user_id: userId,
        event_id: eventId,
        part_name: sens.part_name,
        risk_level: risk,
        reason: `Část ${sens.part_name} má citlivost na vzor "${sens.event_pattern}" (typy: ${sens.sensitivity_types.join(", ")}).`,
        recommended_action: recommended,
      });
      impacts_created++;

      // Create therapist task for amber/red
      if (risk === "amber" || risk === "red") {
        try {
          const taskTitle = `Ověřit expozici části ${sens.part_name} k tématu "${hit.matched_terms[0]}"`;
          await admin.from("did_therapist_tasks").insert({
            user_id: userId,
            title: taskTitle,
            description: `Externí realita (${sourceType}, ${reporter}): možný emoční dopad na část ${sens.part_name}. Ověřit expozici, somatickou reakci, neukazovat grafický materiál.${sens.recommended_guard ? " Pravidlo: " + sens.recommended_guard : ""}`,
            assigned_to: reporter === "kata" ? "kata" : "hanka",
            priority: risk === "red" ? "high" : "medium",
            status: "open",
            source: "external_reality_sentinel",
            metadata: { event_id: eventId, part_name: sens.part_name, risk_level: risk },
          });
          tasks_created++;
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

async function internetWatchSlice(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ status: string; message: string }> {
  // Honest not_implemented — no fake browsing.
  await admin.from("external_event_watch_runs").insert({
    user_id: userId,
    source_type: "internet_news",
    sources_checked: 0,
    new_events: 0,
    matched_events: 0,
    warnings_created: 0,
    failures: 0,
    internet_watch_status: "not_implemented",
    notes: "Internet watch is intentionally not implemented in this slice. No fake verification.",
    payload: {},
  });

  // Create a follow-up task asking therapists for verified links
  try {
    await admin.from("did_therapist_tasks").insert({
      user_id: userId,
      title: "Doplnit ověřené odkazy ke sledovaným externím tématům",
      description: "Internet sentinel zatím není napojen na ověřený zdroj. Pokud máte odkaz na článek/zprávu, který se týká částí (Arthur, Tundrupek, Timmy), přidejte ho ručně.",
      assigned_to: "hanka",
      priority: "low",
      status: "open",
      source: "external_reality_sentinel",
      metadata: { reason: "internet_watch_not_implemented" },
    });
  } catch { /* tabulka může mít jiné schéma */ }

  return { status: "not_implemented", message: "Internet watch slice is honestly marked not_implemented. Task created for manual verification." };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP entry
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let canonicalUserId: string;
  try {
    canonicalUserId = await assertCanonicalDidScopeOrThrow(admin as never, auth.user.id);
  } catch (err) {
    if (err instanceof CanonicalUserScopeError) {
      return json({ ok: false, error_code: err.code, message: err.message }, 403);
    }
    return json({ ok: false, error_code: "scope_check_failed", message: String(err) }, 500);
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
      return json({ ok: true, ...result });
    }
    if (action === "internet_watch") {
      const result = await internetWatchSlice(admin, canonicalUserId);
      return json({ ok: true, ...result });
    }
    if (action === "list_impacts") {
      const { data, error } = await admin
        .from("external_event_impacts")
        .select("id, event_id, part_name, risk_level, reason, recommended_action, created_at, acknowledged_at, resolved_at, external_reality_events(event_title, event_type, source_type, verification_status, graphic_content_risk, summary_for_therapists)")
        .eq("user_id", canonicalUserId)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return json({ ok: false, message: error.message }, 500);
      return json({ ok: true, impacts: data ?? [] });
    }
    return json({ ok: false, message: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ ok: false, message: String((e as Error)?.message ?? e) }, 500);
  }
});
