import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { appendPantryB } from "../_shared/pantryB.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void };

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";
const MODEL_TIER = "high-capability";
const REASONING_EFFORT = "high";

const TECHNICAL_FALLBACK_RE = /(Slyším tě\. Teď se mi na chvilku zasekl hlas|Karel tě slyší|technicky zasekla odpověď|zasekl se mi hlas|Karel neodpověděl|Herna zůstává otevřená)/i;
const pragueDayISO = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text || p?.content || (p?.image_url ? "[přiložený obrázek]" : p?.type ? `[příloha:${p.type}]` : "")).filter(Boolean).join("\n");
  if (content && typeof content === "object") return JSON.stringify(content).slice(0, 1200);
  return "";
};
const normalizePart = (v: unknown) => String(v ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const targetForPart = (partName: string) => `KARTA_${String(partName || "UNKNOWN").toUpperCase()}`;

const PLAYROOM_TOOL = {
  type: "function",
  function: {
    name: "emit_playroom_review",
    description: "Vrátí oddělenou detailní odbornou analýzu Herny a praktický report pro další terapeutické plánování.",
    parameters: {
      type: "object",
      properties: {
        completion_status: { type: "string", enum: ["completed", "partial", "evidence_limited"] },
        main_theme: { type: "string" },
        detailed_analysis_text: { type: "string" },
        practical_report_text: { type: "string" },
        clinical_summary: { type: "string" },
        key_findings: { type: "array", items: { type: "string" }, maxItems: 8 },
        implications_for_part: { type: "string" },
        implications_for_system: { type: "string" },
        recommendations_for_therapists: { type: "string" },
        recommendations_for_next_playroom: { type: "string" },
        recommendations_for_next_session: { type: "string" },
        risks: { type: "array", items: { type: "string" }, maxItems: 6 },
        stabilizing_factors: { type: "array", items: { type: "string" }, maxItems: 6 },
        destabilizing_factors: { type: "array", items: { type: "string" }, maxItems: 6 },
        what_not_to_do: { type: "array", items: { type: "string" }, maxItems: 6 },
        open_questions: { type: "array", items: { type: "string" }, maxItems: 8 },
        hypothesis_changes: { type: "array", items: { type: "string" }, maxItems: 5 },
        plan_changes: { type: "array", items: { type: "string" }, maxItems: 5 }
      },
      required: ["completion_status", "main_theme", "detailed_analysis_text", "practical_report_text", "clinical_summary", "key_findings", "implications_for_part", "implications_for_system", "recommendations_for_therapists", "recommendations_for_next_playroom", "recommendations_for_next_session", "risks", "stabilizing_factors", "destabilizing_factors", "what_not_to_do", "open_questions", "hypothesis_changes", "plan_changes"],
      additionalProperties: false
    }
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function mergeAnalysisJson(existing: any, patch: any) {
  const base = existing && typeof existing === "object" ? existing : {};
  return { ...base, ...patch };
}

function hasCompletedReviewText(review: any) {
  const a = review?.analysis_json ?? {};
  return String(a.detailed_analysis_text || "").trim().length > 0 || String(a.practical_report_text || "").trim().length > 0;
}

async function authenticatedUserId(req: Request, supabaseUrl: string, anonKey: string): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const authClient = createClient(supabaseUrl, anonKey);
  const { data } = await authClient.auth.getUser(token);
  return data.user?.id ?? null;
}

async function callAi(prompt: string, apiKey: string) {
  const res = await fetch(AI_URL, {
    method: "POST",
    signal: AbortSignal.timeout(95_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      messages: [
        { role: "system", content: `Jsi Karel, klinický supervizor a vedoucí terapeutického týmu. Vyhodnocuješ Karel-led Hernu, nikoli terapeutkou vedené Sezení. Piš česky. Nikdy nepoužívej slova "systém" nebo "klient"; říkej "kluci" nebo jménem části. Nevymýšlej obsah nepřepsaných příloh. Technické fallbacky explicitně označ jako technické a nepoužívej je jako klinický důkaz. Vrať pouze tool call.` },
        { role: "user", content: prompt },
      ],
      tools: [PLAYROOM_TOOL],
      tool_choice: { type: "function", function: { name: "emit_playroom_review" } },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 429) throw new Error("AI rate limit překročen.");
    if (res.status === 402) throw new Error("AI kredit vyčerpán.");
    throw new Error(`AI gateway ${res.status}: ${t.slice(0, 240)}`);
  }
  const data = await res.json();
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error("AI nevrátila strukturované vyhodnocení Herny.");
  return JSON.parse(args);
}

async function loadContext(sb: any, planId: string, threadId: string, userId: string) {
  const { data: plan, error: planErr } = await sb.from("did_daily_session_plans").select("*").eq("id", planId).eq("user_id", userId).maybeSingle();
  if (planErr) throw planErr;
  if (!plan) return { status: "missing_valid_playroom_plan", reason: "plan_not_found" };
  const c = plan.urgency_breakdown && typeof plan.urgency_breakdown === "object" ? plan.urgency_breakdown : {};
  const validPlan = c.session_actor === "karel_direct" && c.ui_surface === "did_kids_playroom" && c.playroom_plan && typeof c.playroom_plan === "object" && (c.approved_for_child_session === true || ["approved", "ready_to_start", "in_progress"].includes(String(plan.program_status || c.review_state || c.approval?.review_state || "")));
  if (!validPlan) return { status: "missing_valid_playroom_plan", reason: "invalid_or_unapproved_playroom_contract", plan };
  const { data: thread, error: threadErr } = await sb.from("did_threads").select("id,user_id,part_name,sub_mode,workspace_type,workspace_id,messages,thread_label,started_at,last_activity_at").eq("id", threadId).eq("user_id", userId).maybeSingle();
  if (threadErr) throw threadErr;
  if (!thread) return { status: "missing_valid_playroom_plan", reason: "thread_not_found", plan };
  const threadOk = thread.workspace_type === "session" && String(thread.workspace_id) === String(planId) && ["karel_part_session", "playroom"].includes(String(thread.sub_mode || "")) && (!thread.part_name || normalizePart(thread.part_name) === normalizePart(plan.selected_part));
  if (!threadOk) return { status: "missing_valid_playroom_plan", reason: "thread_not_bound_to_plan", plan, thread };
  const { data: liveProgress } = await sb.from("did_live_session_progress").select("*").eq("plan_id", planId).maybeSingle();
  const { data: partRows } = await sb.from("did_part_registry").select("id,part_name,display_name,status,age_estimate,role_in_system,last_emotional_state,drive_folder_label,updated_at").eq("user_id", userId);
  const partCard = (partRows ?? []).find((p: any) => [p.part_name, p.display_name, p.drive_folder_label].some((v) => normalizePart(v) === normalizePart(plan.selected_part))) ?? null;
  return { status: "valid", plan, thread, liveProgress: liveProgress ?? null, partCard };
}

function buildTranscript(thread: any, turnsByBlock: Record<string, any[]>) {
  const excluded: any[] = [];
  const clinical: any[] = [];
  const source = Object.keys(turnsByBlock || {}).length
    ? Object.values(turnsByBlock).flat().map((t: any) => ({ from: t.from, text: t.text }))
    : (Array.isArray(thread?.messages) ? thread.messages : []).map((m: any) => ({ from: String(m.role) === "assistant" ? "karel" : "child", text: textOf(m.content) }));
  source.forEach((turn: any, index: number) => {
    const text = String(turn.text || "").trim();
    if (!text) return;
    const normalized = { index, from: turn.from === "karel" ? "karel" : "child", text: text.slice(0, 1800) };
    if (TECHNICAL_FALLBACK_RE.test(text) || turn.is_technical_fallback || turn.exclude_from_clinical_evidence) excluded.push({ ...normalized, is_technical_fallback: true, exclude_from_clinical_evidence: true, fallback_reason: "known_playroom_technical_fallback" });
    else clinical.push(normalized);
  });
  return { clinical, excluded };
}

function buildPrompt(ctx: any, input: any, transcript: { clinical: any[]; excluded: any[] }) {
  const p = ctx.plan;
  const playroomPlan = p.urgency_breakdown?.playroom_plan;
  return `IDENTIFIKACE HERNY
- plan_id: ${p.id}
- thread_id: ${ctx.thread.id}
- část: ${p.selected_part}
- datum: ${p.plan_date}
- typ: Karel-led Herna, NE terapeutkou vedené Sezení
- completed_blocks: ${input.completedBlocks ?? ctx.liveProgress?.completed_blocks ?? "?"}/${input.totalBlocks ?? ctx.liveProgress?.total_blocks ?? "?"}
- ended_reason: ${input.endedReason || "manual_end"}

SCHVÁLENÝ PLAYROOM_PLAN — PRIMÁRNÍ PROGRAM HERNY:
${JSON.stringify(playroomPlan, null, 2).slice(0, 12000)}

LIVE PROGRESS / PROGRAM EVIDENCE:
${JSON.stringify({ items: ctx.liveProgress?.items ?? [], turns_by_block: ctx.liveProgress?.turns_by_block ?? {}, artifacts_by_block: ctx.liveProgress?.artifacts_by_block ?? {}, finalized_at: ctx.liveProgress?.finalized_at ?? null, current_block_id: ctx.liveProgress?.current_block_id ?? null }, null, 2).slice(0, 9000)}

KARTA ČÁSTI / REGISTRY MIRROR:
${JSON.stringify(ctx.partCard ?? { available: false }, null, 2).slice(0, 4000)}

KLINICKY POUŽITELNÝ TRANSCRIPT (child/karel):
${transcript.clinical.map((t) => `${t.from}: ${t.text}`).join("\n").slice(0, 16000) || "(žádný klinicky použitelný textový transcript)"}

TECHNICKÉ FALLBACKY — NEJSOU KLINICKÝ DŮKAZ:
${transcript.excluded.map((t) => `${t.from}: ${t.text}`).join("\n") || "(žádné)"}

ÚKOL:
Vytvoř dvě oddělené vrstvy výstupu:
(1) detailní profesionální analýzu — dlouhou strukturovanou zprávu se vztahem k playroom_plan, blokům, evidenci dokončení, tomu, co část skutečně řekla/udělala, limitům evidence, rizikům, stabilizačním faktorům a doporučením.
(2) praktický report — kratší praktický výstup pro ranní přehled, terapeutky a návrh další Herny.
Pokud evidence nestačí, nastav completion_status=evidence_limited a jasně napiš, co lze a nelze vyvodit. Nepoužívej plan_markdown jako náhradu playroom_plan.`;
}

function practicalLogMarkdown(args: any) {
  const r = args.review;
  return `## Herna — ${args.partName} (${args.date})

- plan_id: ${args.planId}
- thread_id: ${args.threadId}
- review_id: ${args.reviewId}
- status: ${args.status}
- téma: ${r.main_theme || "nezaznamenáno"}

### Praktický report
${r.practical_report_text}

### Závazné důsledky
- Pro část: ${r.implications_for_part}
- Pro kluky: ${r.implications_for_system}
- Pro terapeutky: ${r.recommendations_for_therapists}
- Další Herna: ${r.recommendations_for_next_playroom}
- Další Sezení: ${r.recommendations_for_next_session}

### Bezpečnost
${(r.risks || []).map((x: string) => `- ${x}`).join("\n") || "- bez samostatného rizika v dostupné evidenci"}`.trim();
}

async function upsertReview(sb: any, ctx: any, input: any, review: any, transcript: any) {
  const now = new Date().toISOString();
  const completedBlocks = Number(input.completedBlocks ?? ctx.liveProgress?.completed_blocks ?? 0);
  const totalBlocks = Number(input.totalBlocks ?? ctx.liveProgress?.total_blocks ?? (Array.isArray(ctx.liveProgress?.items) ? ctx.liveProgress.items.length : 0));
  const status = review.completion_status === "completed" && transcript.clinical.some((t: any) => t.from === "child") ? "analyzed" : review.completion_status === "partial" ? "partially_analyzed" : "evidence_limited";
  const programEvidence = { completed_blocks: completedBlocks, total_blocks: totalBlocks, completion_ratio: totalBlocks ? completedBlocks / totalBlocks : null, items: ctx.liveProgress?.items ?? [], turns_by_block: ctx.liveProgress?.turns_by_block ?? {}, artifacts_by_block: ctx.liveProgress?.artifacts_by_block ?? {} };
  const analysisJson = {
    schema: "did_playroom_review.v1",
    detailed_analysis_text: review.detailed_analysis_text,
    practical_report_text: review.practical_report_text,
    program_evidence: programEvidence,
    excluded_technical_fallbacks: transcript.excluded,
    model_used: MODEL,
    model_tier: MODEL_TIER,
    reasoning_effort: REASONING_EFFORT,
    created_from: "karel-did-playroom-evaluate",
    playroom_plan: ctx.plan.urgency_breakdown?.playroom_plan,
    key_findings: review.key_findings ?? [],
    risks: review.risks ?? [],
    stabilizing_factors: review.stabilizing_factors ?? [],
    destabilizing_factors: review.destabilizing_factors ?? [],
    what_not_to_do: review.what_not_to_do ?? [],
    open_questions: review.open_questions ?? [],
    hypothesis_changes: review.hypothesis_changes ?? [],
    plan_changes: review.plan_changes ?? [],
  };
  const payload = {
    user_id: ctx.plan.user_id,
    plan_id: ctx.plan.id,
    part_name: ctx.plan.selected_part,
    session_date: ctx.plan.plan_date,
    mode: "playroom",
    review_kind: "karel_direct_playroom",
    status,
    analysis_version: "did-playroom-review-v1",
    source_data_summary: `playroom:${completedBlocks}/${totalBlocks}:clinical_turns=${transcript.clinical.length}:technical_fallbacks=${transcript.excluded.length}`,
    evidence_items: [
      { kind: "approved_playroom_plan", available: true, source_table: "did_daily_session_plans", source_id: ctx.plan.id },
      { kind: "bound_thread", available: true, source_table: "did_threads", source_id: ctx.thread.id, message_count: Array.isArray(ctx.thread.messages) ? ctx.thread.messages.length : 0 },
      { kind: "live_progress", available: !!ctx.liveProgress, completed_blocks: completedBlocks, total_blocks: totalBlocks },
      { kind: "clinical_transcript", available: transcript.clinical.length > 0, turn_count: transcript.clinical.length },
      { kind: "technical_fallbacks_excluded", available: transcript.excluded.length > 0, count: transcript.excluded.length },
      { kind: "part_card", available: !!ctx.partCard, source_table: "did_part_registry", part_name: ctx.partCard?.part_name ?? null },
    ],
    completed_checklist_items: Array.isArray(ctx.liveProgress?.items) ? ctx.liveProgress.items.filter((i: any) => i?.done === true || i?.completed === true || i?.status === "done") : [],
    missing_checklist_items: Array.isArray(ctx.liveProgress?.items) ? ctx.liveProgress.items.filter((i: any) => !(i?.done === true || i?.completed === true || i?.status === "done")) : [],
    transcript_available: transcript.clinical.length > 0,
    live_progress_available: !!ctx.liveProgress,
    clinical_summary: review.clinical_summary || String(review.practical_report_text || "").slice(0, 1200),
    clinical_findings: (review.key_findings || []).join("\n"),
    implications_for_part: review.implications_for_part,
    implications_for_whole_system: review.implications_for_system,
    recommendations_for_therapists: review.recommendations_for_therapists,
    recommendations_for_next_playroom: review.recommendations_for_next_playroom,
    recommendations_for_next_session: review.recommendations_for_next_session,
    therapeutic_implications: review.implications_for_part,
    team_implications: review.recommendations_for_therapists,
    next_session_recommendation: review.recommendations_for_next_session,
    evidence_limitations: status === "evidence_limited" ? "Evidence Herny je omezená; závěry jsou pracovní a vycházejí jen ze skutečně uloženého transcriptu/progressu." : null,
    main_topic: review.main_theme,
    program_title: ctx.plan.urgency_breakdown?.playroom_plan?.title || ctx.plan.urgency_breakdown?.main_topic || `Herna — ${ctx.plan.selected_part}`,
    lead_person: "Karel",
    assistant_persons: [],
    approved_program_id: ctx.plan.id,
    analysis_json: analysisJson,
    kartoteka_card_target: targetForPart(ctx.plan.selected_part),
    drive_sync_status: "queued",
    source_of_truth_status: "pending_drive_sync",
    synced_to_drive: false,
    projection_status: "queued",
    updated_at: now,
  };
  const { data: existing } = await sb.from("did_session_reviews").select("id,analysis_json,drive_sync_status,source_of_truth_status,synced_to_drive,detail_analysis_drive_url,practical_report_drive_url").eq("plan_id", ctx.plan.id).eq("is_current", true).maybeSingle();
  if (existing?.id) {
    const existingJson = existing.analysis_json && typeof existing.analysis_json === "object" ? existing.analysis_json : {};
    const nextPayload = {
      ...payload,
      analysis_json: mergeAnalysisJson(existingJson, analysisJson),
      drive_sync_status: existing.drive_sync_status && existing.drive_sync_status !== "not_queued" ? existing.drive_sync_status : payload.drive_sync_status,
      source_of_truth_status: existing.source_of_truth_status && existing.source_of_truth_status !== "pending_drive_sync" ? existing.source_of_truth_status : payload.source_of_truth_status,
      synced_to_drive: existing.synced_to_drive === true ? true : payload.synced_to_drive,
      detail_analysis_drive_url: existing.detail_analysis_drive_url ?? null,
      practical_report_drive_url: existing.practical_report_drive_url ?? null,
    };
    await sb.from("did_session_reviews").update(nextPayload).eq("id", existing.id);
    return existing.id;
  }
  const { data: inserted, error } = await sb.from("did_session_reviews").insert(payload).select("id").single();
  if (error) throw error;
  return inserted.id as string;
}

async function insertOnce(sb: any, table: string, select: any, payload: any) {
  let query = sb.from(table).select("id").limit(1);
  for (const [k, v] of Object.entries(select)) query = query.eq(k, v as any);
  const { data } = await query;
  if (data?.length) return data[0].id;
  const { data: inserted, error } = await sb.from(table).insert(payload).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function persistPantryAndDrive(sb: any, ctx: any, review: any, reviewId: string, status: string) {
  const sourceRef = `playroom-evaluate:${ctx.plan.id}`;
  const baseDetail = { plan_id: ctx.plan.id, thread_id: ctx.thread.id, review_id: reviewId, part_name: ctx.plan.selected_part, practical_report_text: review.practical_report_text, key_findings: review.key_findings ?? [], implications_for_part: review.implications_for_part, implications_for_system: review.implications_for_system, model_used: MODEL };
  await appendPantryB(sb, { user_id: ctx.plan.user_id, entry_kind: "conclusion", source_kind: "playroom", source_ref: sourceRef, related_part_name: ctx.plan.selected_part, summary: review.clinical_summary || review.main_theme || "Vyhodnocená Herna", detail: baseDetail, intended_destinations: ["briefing_input", "did_implications"] });
  await appendPantryB(sb, { user_id: ctx.plan.user_id, entry_kind: "followup_need", source_kind: "playroom", source_ref: `${sourceRef}:followup`, related_part_name: ctx.plan.selected_part, summary: review.recommendations_for_therapists || "Follow-up z Herny", detail: { recommendations_for_therapists: review.recommendations_for_therapists, recommendations_for_next_playroom: review.recommendations_for_next_playroom, recommendations_for_next_session: review.recommendations_for_next_session, what_not_to_do: review.what_not_to_do ?? [] }, intended_destinations: ["briefing_input", "did_therapist_tasks"] });
  if ((review.risks ?? []).length) await appendPantryB(sb, { user_id: ctx.plan.user_id, entry_kind: "risk", source_kind: "playroom", source_ref: `${sourceRef}:risk`, related_part_name: ctx.plan.selected_part, summary: review.risks.join("; ").slice(0, 1000), detail: { risks: review.risks }, intended_destinations: ["briefing_input", "did_implications"] });
  if ((review.hypothesis_changes ?? []).length) await appendPantryB(sb, { user_id: ctx.plan.user_id, entry_kind: "hypothesis_change", source_kind: "playroom", source_ref: `${sourceRef}:hypothesis`, related_part_name: ctx.plan.selected_part, summary: review.hypothesis_changes.join("; ").slice(0, 1000), detail: { hypothesis_changes: review.hypothesis_changes }, intended_destinations: ["briefing_input", "did_implications"] });
  if ((review.plan_changes ?? []).length) await appendPantryB(sb, { user_id: ctx.plan.user_id, entry_kind: "plan_change", source_kind: "playroom", source_ref: `${sourceRef}:plan`, related_part_name: ctx.plan.selected_part, summary: review.plan_changes.join("; ").slice(0, 1000), detail: { plan_changes: review.plan_changes }, intended_destinations: ["briefing_input", "did_implications"] });

  const target = targetForPart(ctx.plan.selected_part);
  const log = practicalLogMarkdown({ review, partName: ctx.plan.selected_part, date: ctx.plan.plan_date, planId: ctx.plan.id, threadId: ctx.thread.id, reviewId, status });
  const packages = [
    { package_type: "playroom_detail_analysis", content_md: review.detailed_analysis_text, drive_target_path: target, report_kind: "detail_analysis", content_type: "playroom_detail_analysis" },
    { package_type: "playroom_practical_report", content_md: review.practical_report_text, drive_target_path: target, report_kind: "practical_report", content_type: "playroom_practical_report" },
    { package_type: "playroom_log", content_md: log, drive_target_path: "KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG", report_kind: "central_log", content_type: "playroom_log" },
  ];
  const writeIds: string[] = [];
  for (const pkg of packages) {
    const metadata = { review_id: reviewId, plan_id: ctx.plan.id, thread_id: ctx.thread.id, part_name: ctx.plan.selected_part, mode: "playroom", report_kind: pkg.report_kind };
    const packageId = await insertOnce(sb, "did_pantry_packages", { package_type: pkg.package_type, source_id: ctx.plan.id }, { user_id: ctx.plan.user_id, package_type: pkg.package_type, source_id: ctx.plan.id, source_table: "did_daily_session_plans", content_md: pkg.content_md, drive_target_path: pkg.drive_target_path, metadata, status: "pending_drive", flushed_at: null });
    const content = encodeGovernedWrite(pkg.content_md, { source_type: "did_session_review", source_id: reviewId, content_type: pkg.content_type as any, subject_type: pkg.package_type === "playroom_log" ? "system" : "part", subject_id: ctx.plan.selected_part, payload_fingerprint: `playroom:${reviewId}:${pkg.package_type}` });
    const writeId = await insertOnce(sb, "did_pending_drive_writes", { target_document: pkg.drive_target_path, content }, { user_id: ctx.plan.user_id, target_document: pkg.drive_target_path, content, write_type: "append", priority: "normal", status: "pending" });
    writeIds.push(writeId);
    await sb.from("did_pantry_packages").update({ metadata: { ...metadata, pending_drive_write_id: writeId } }).eq("id", packageId);
  }
  await sb.from("did_session_reviews").update({ analysis_json: mergeAnalysisJson(review.analysis_json, { drive_write_ids: writeIds, processing_status: "completed" }), drive_sync_status: "queued", source_of_truth_status: "pending_drive_sync" }).eq("id", reviewId);
  return { writeIds };
}

async function persistInvalidAudit(sb: any, ctx: any, userId: string, planId: string, reason: string) {
  const plan = ctx?.plan;
  if (!plan) return null;
  const payload = { user_id: userId, plan_id: planId, part_name: plan.selected_part ?? null, session_date: plan.plan_date ?? pragueDayISO(), mode: "playroom", review_kind: "karel_direct_playroom", status: "evidence_limited", analysis_version: "did-playroom-review-v1-invalid-plan", source_data_summary: `missing_valid_playroom_plan:${reason}`, evidence_items: [{ kind: "valid_playroom_contract", available: false, reason }], completed_checklist_items: [], missing_checklist_items: [], transcript_available: false, live_progress_available: false, clinical_summary: "Herna neměla platně ověřený schválený playroom_plan, proto nevznikla plná klinická analýza.", evidence_limitations: "Backend neověřil platnou vazbu planId/threadId/schválený playroom_plan.", analysis_json: { schema: "did_playroom_review.v1", status: "missing_valid_playroom_plan", reason, created_from: "karel-did-playroom-evaluate" }, drive_sync_status: "skipped", source_of_truth_status: "skipped", projection_status: "skipped" };
  const { data: inserted } = await sb.from("did_session_reviews").insert(payload).select("id").single();
  return inserted?.id ?? null;
}

async function ensurePendingReview(sb: any, userId: string, planId: string, threadId: string, partName?: string) {
  const { data: existing } = await sb.from("did_session_reviews").select("id,status,analysis_json").eq("plan_id", planId).eq("is_current", true).maybeSingle();
  if (existing?.id) {
    if (!hasCompletedReviewText(existing)) {
      await sb.from("did_session_reviews").update({ status: "pending_review", analysis_json: mergeAnalysisJson(existing.analysis_json, { processing_status: "pending_review", thread_id: threadId, queued_at: new Date().toISOString(), created_from: "karel-did-playroom-evaluate" }) }).eq("id", existing.id);
    }
    return existing.id as string;
  }
  const { data: plan } = await sb.from("did_daily_session_plans").select("id,user_id,plan_date,selected_part").eq("id", planId).maybeSingle();
  const payload = {
    user_id: userId,
    plan_id: planId,
    part_name: plan?.selected_part ?? partName ?? null,
    session_date: plan?.plan_date ?? pragueDayISO(),
    mode: "playroom",
    review_kind: "karel_direct_playroom",
    status: "pending_review",
    analysis_version: "did-playroom-review-v1",
    source_data_summary: `playroom_pending:thread=${threadId}`,
    evidence_items: [{ kind: "bound_thread", available: true, source_table: "did_threads", source_id: threadId }],
    completed_checklist_items: [],
    missing_checklist_items: [],
    transcript_available: false,
    live_progress_available: false,
    clinical_summary: "Herna byla ukončena a čeká na backendové vyhodnocení.",
    evidence_limitations: "Vyhodnocení je ve frontě; závěry zatím nejsou hotové.",
    analysis_json: { schema: "did_playroom_review.v1", status: "pending_review", thread_id: threadId, created_from: "karel-did-playroom-evaluate" },
    drive_sync_status: "not_queued",
    source_of_truth_status: "pending_drive_sync",
    projection_status: "queued",
  };
  const { data: inserted, error } = await sb.from("did_session_reviews").insert(payload).select("id").single();
  if (error) throw error;
  return inserted.id as string;
}

async function processEvaluation(sb: any, apiKey: string, userId: string, body: any) {
  const planId = String(body.planId || "").trim();
  const threadId = String(body.threadId || "").trim();
  const { data: existingReview } = await sb.from("did_session_reviews").select("id,status,analysis_json").eq("plan_id", planId).eq("is_current", true).maybeSingle();
  await sb.from("did_session_reviews").update({ status: hasCompletedReviewText(existingReview) ? existingReview.status : "analysis_running", analysis_json: mergeAnalysisJson(existingReview?.analysis_json, { processing_status: "analysis_running", thread_id: threadId, started_at: new Date().toISOString(), created_from: "karel-did-playroom-evaluate" }) }).eq("plan_id", planId).eq("is_current", true);
  const ctx = await loadContext(sb, planId, threadId, userId);
  if (ctx.status !== "valid") {
    const reviewId = await persistInvalidAudit(sb, ctx, userId, planId, ctx.reason || "invalid");
    return { ok: false, status: "missing_valid_playroom_plan", reason: ctx.reason, review_id: reviewId };
  }
  const transcript = buildTranscript(ctx.thread, body.turnsByBlock || ctx.liveProgress?.turns_by_block || {});
  const prompt = buildPrompt(ctx, body, transcript);
  const review = await callAi(prompt, apiKey);
  const reviewId = await upsertReview(sb, ctx, body, review, transcript);
  const { data: persistedReview } = await sb.from("did_session_reviews").select("status,analysis_json").eq("id", reviewId).maybeSingle();
  review.analysis_json = persistedReview?.analysis_json ?? {};
  const drive = await persistPantryAndDrive(sb, ctx, review, reviewId, persistedReview?.status ?? "analyzed");
  await sb.from("did_live_session_progress").update({ finalized_at: new Date().toISOString(), finalized_reason: body.endedReason || "manual_end", updated_at: new Date().toISOString() }).eq("plan_id", planId);
  await sb.from("did_daily_session_plans").update({ status: "done", lifecycle_status: "completed", completed_at: new Date().toISOString(), finalized_at: new Date().toISOString(), finalization_source: "karel-did-playroom-evaluate", finalization_reason: body.endedReason || "manual_end", updated_at: new Date().toISOString() }).eq("id", planId);
  return { ok: true, status: persistedReview?.status ?? "analyzed", review_id: reviewId, mode: "playroom", review_kind: "karel_direct_playroom", drive_write_ids: drive.writeIds, model_used: MODEL };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    const userId = await authenticatedUserId(req, supabaseUrl, anonKey);
    if (!userId) return json({ ok: false, error: "Nepřihlášený požadavek." }, 401);
    const body = await req.json().catch(() => ({}));
    const planId = String(body.planId || "").trim();
    const threadId = String(body.threadId || "").trim();
    if (!planId || !threadId) return json({ ok: false, error: "Chybí planId nebo threadId." }, 400);
    const sb = createClient(supabaseUrl, serviceKey);
    if (body.async === true || body.enqueueOnly === true) {
      const reviewId = await ensurePendingReview(sb, userId, planId, threadId, body.partName);
      EdgeRuntime.waitUntil(processEvaluation(sb, apiKey, userId, body).catch(async (e: any) => {
        console.error("[playroom-evaluate] async failed", e);
        await sb.from("did_session_reviews").update({ status: "failed_retry", last_sync_error: String(e?.message ?? e).slice(0, 1000), analysis_json: { schema: "did_playroom_review.v1", status: "failed_retry", error: String(e?.message ?? e).slice(0, 1000), thread_id: threadId, created_from: "karel-did-playroom-evaluate" } }).eq("id", reviewId);
      }));
      return json({ ok: true, queued: true, status: "pending_review", review_id: reviewId, mode: "playroom", review_kind: "karel_direct_playroom" });
    }
    return json(await processEvaluation(sb, apiKey, userId, body));
  } catch (e: any) {
    console.error("[playroom-evaluate] fatal", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});
