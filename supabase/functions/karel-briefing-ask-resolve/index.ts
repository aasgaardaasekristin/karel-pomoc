const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { appendPantryB } from "../_shared/pantryB.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const sha256 = async (text: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const lastTherapistResponse = (messages: any[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && String(m?.content ?? "").trim()) return String(m.content).trim();
  }
  return "";
};

const arrayify = (value: unknown) => Array.isArray(value) ? value : [];

const findAsk = (payload: any, askId: string) => {
  const all = [...arrayify(payload?.ask_hanka), ...arrayify(payload?.ask_kata)];
  return all.find((item: any) => String(item?.id ?? "") === askId) ?? null;
};

const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const safeJson = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
const stableTargetKey = (briefingId: string, targetType: string, partName: string | null) => `${briefingId}:${targetType}:${partName || "unknown"}`;

function normalizeAskMetadata(briefing: any, ask: any, assignee: "hanka" | "kata") {
  const text = String(ask?.text ?? ask?.question_text ?? "");
  const lower = norm(text);
  const isPlayroom = lower.includes("herna") || lower.includes("hry") || lower.includes("prakticky report") || lower.includes("hravy");
  const isSession = !isPlayroom && (lower.includes("sezeni") || lower.includes("session") || lower.includes("terapeutick"));
  const isTask = lower.includes("ukol") || lower.includes("domluv") || lower.includes("zarid") || lower.includes("pripomen");
  const isObservation = lower.includes("sleduj") || lower.includes("pozoruj") || lower.includes("over") || lower.includes("zkontroluj") || lower.includes("rizik") || lower.includes("stop signal");
  const payload = briefing?.payload ?? {};
  const targetType = String(ask?.target_type ?? (isPlayroom ? "proposed_playroom" : isSession ? "proposed_session" : isTask ? "task" : isObservation ? "current_handling" : "none"));
  const target = targetType === "proposed_playroom" ? payload.proposed_playroom : targetType === "proposed_session" ? payload.proposed_session : null;
  const targetPartName = ask?.target_part_name ? String(ask.target_part_name) : (target?.part_name ? String(target.part_name) : null);
  const targetItemId = ask?.target_item_id ? String(ask.target_item_id) : (target?.id ? String(target.id) : (targetType === "proposed_playroom" || targetType === "proposed_session" ? stableTargetKey(briefing.id, targetType, targetPartName) : null));
  const intent = String(ask?.intent ?? (targetType === "proposed_playroom" ? "playroom_plan" : targetType === "proposed_session" ? "session_plan" : isTask ? "task" : isObservation ? "observation" : "team_coordination"));
  return { ...ask, text, assignee, intent, target_type: targetType, target_item_id: targetItemId, target_part_name: targetPartName, requires_immediate_program_update: targetType === "proposed_playroom" || targetType === "proposed_session", expected_resolution: targetType === "proposed_playroom" || targetType === "proposed_session" ? "update_program" : isTask ? "create_task" : isObservation ? "add_observation" : "store_memory" };
}

function buildDecision(ask: any, therapistResponse: string, resolutionMode: string) {
  const text = norm(`${ask?.text ?? ""} ${therapistResponse}`);
  const targetType = String(ask?.target_type ?? "none");
  const clinicalCaution = /test|diagnost|profesion|vyhodnot|disoci|prep[ií]n|strid|stř[ií]d/.test(text) || targetType !== "none";
  const decision = resolutionMode === "close_no_change" ? "close_no_change"
    : resolutionMode === "create_task" ? "create_task"
    : targetType === "proposed_playroom" ? "apply_to_playroom_program"
    : targetType === "proposed_session" ? "apply_to_session_program"
    : targetType === "current_handling" ? "apply_to_current_handling"
    : therapistResponse.length < 12 ? "ask_for_clarification"
    : "store_as_observation";
  return {
    decision,
    confidence: targetType === "proposed_playroom" || targetType === "proposed_session" ? "high" : "medium",
    requires_reapproval: decision === "apply_to_playroom_program" || decision === "apply_to_session_program",
    clinical_caution: clinicalCaution,
    evidence_level: "therapist_observation_D2",
    target_type: targetType,
    target_item_id: ask?.target_item_id ?? null,
    target_part_name: ask?.target_part_name ?? null,
    reasoning_summary: decision === "apply_to_playroom_program"
      ? "Odpověď terapeutky se vztahuje k dnešní Herně; Karel ji smí použít jen jako D2 terapeutické pozorování a převést diagnostický jazyk do bezpečných observačních prvků."
      : decision === "apply_to_session_program"
        ? "Odpověď terapeutky se vztahuje k dnešnímu Sezení; změna programu vyžaduje opatrnou revizi a nové schválení."
        : "Odpověď nevyžaduje přímý přepis programu; patří do operační paměti nebo úkolů.",
  };
}

function changedKeys(before: any, after: any) {
  const keys = Array.from(new Set([...Object.keys(safeJson(before)), ...Object.keys(safeJson(after))]));
  return keys.filter((k) => JSON.stringify((before ?? {})[k] ?? null) !== JSON.stringify((after ?? {})[k] ?? null));
}

function buildProgramPrefill(payload: any, ask: any, assignee: "hanka" | "kata") {
  if (ask.target_type === "proposed_playroom" && payload?.proposed_playroom) {
    const s = payload.proposed_playroom;
    const program = Array.isArray(s.playroom_plan?.therapeutic_program) ? s.playroom_plan.therapeutic_program : [];
    return {
      title: `Plán dnešní herny s ${s.part_name}`,
      reason: [s.main_theme, s.why_this_part_today].filter(Boolean).join(" — "),
      initial_karel_brief: [`🎲 **Plán dnešní herny s ${s.part_name}**`, "", `*Hlavní téma:* ${s.main_theme}`, `*Proč právě dnes:* ${s.why_this_part_today}`, "", "Tento bod vznikl z Karlova přehledu a odpověď terapeutky se bude započítávat do živého programu."].join("\n"),
      karel_proposed_plan: [`Část: ${s.part_name}`, `Stav: ${s.status || "awaiting_therapist_review"}`, `Hlavní téma: ${s.main_theme}`, "", s.goals?.length ? `Cíle:\n${s.goals.map((g: string, i: number) => `${i + 1}. ${g}`).join("\n")}` : "", s.playroom_plan?.child_safe_version ? `Dětsky bezpečná verze:\n${s.playroom_plan.child_safe_version}` : ""].filter(Boolean).join("\n"),
      agenda_outline: program,
      questions_for_hanka: assignee === "hanka" ? [ask.text || ask.question_text] : [],
      questions_for_kata: assignee === "kata" ? [ask.text || ask.question_text] : [],
      session_params: {
        part_name: s.part_name,
        led_by: "Karel",
        session_format: "playroom",
        why_today: s.why_this_part_today,
        session_mode: "playroom",
        session_actor: "karel_direct",
        ui_surface: "did_kids_playroom",
        approved_for_child_session: false,
        human_review_required: true,
        review_state: "in_revision",
        playroom_plan: s.playroom_plan,
      },
    };
  }

  const s = payload?.proposed_session;
  if (ask.target_type === "proposed_session" && s) {
    return {
      title: `Plán sezení s ${s.part_name}`,
      reason: [s.why_today, s.kata_involvement ? `(Káťa: ${s.kata_involvement})` : ""].filter(Boolean).join(" — "),
      initial_karel_brief: [`📅 **Plán sezení s ${s.part_name}**`, "", `*Proč právě dnes:* ${s.why_today}`, "", "Tento bod vznikl z Karlova přehledu a odpověď terapeutky se bude započítávat do živého programu."].join("\n"),
      karel_proposed_plan: s.first_draft || "",
      agenda_outline: Array.isArray(s.agenda_outline) ? s.agenda_outline : [],
      questions_for_hanka: assignee === "hanka" ? [ask.text || ask.question_text] : [],
      questions_for_kata: assignee === "kata" ? [ask.text || ask.question_text] : [],
      session_params: {
        part_name: s.part_name,
        led_by: s.led_by,
        session_format: s.led_by === "společně" ? "joint" : "individual",
        duration_min: typeof s.duration_min === "number" ? s.duration_min : null,
        why_today: s.why_today,
        kata_involvement: s.kata_involvement ?? null,
        review_state: "in_revision",
        hybrid_contract: s.hybrid_contract ?? null,
      },
    };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth) return json({ error: "unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const userId = userData.user.id;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({}));
    const threadId = String(body.thread_id ?? "");
    if (!threadId) return json({ error: "thread_id_required" }, 400);

    const { data: thread, error: threadErr } = await admin.from("did_threads").select("*").eq("id", threadId).eq("user_id", userId).maybeSingle();
    if (threadErr || !thread) return json({ error: "thread_not_found" }, 404);
    if (!["ask_hanka", "ask_kata"].includes(String(thread.workspace_type ?? ""))) return json({ error: "not_briefing_ask_thread" }, 400);

    const askId = String(thread.workspace_id ?? body.ask_id ?? "");
    const assignee = thread.workspace_type === "ask_kata" ? "kata" : "hanka";
    const therapistResponse = String(body.therapist_response ?? lastTherapistResponse(thread.messages ?? [])).trim();
    if (!therapistResponse && body.resolution_mode !== "close_no_change") return json({ error: "therapist_response_required" }, 400);

    let { data: briefingRows, error: briefingErr } = await admin
      .from("did_daily_briefings")
      .select("id, payload, briefing_date, generated_at")
      .order("generated_at", { ascending: false })
      .limit(25);
    if (briefingErr) throw briefingErr;
    const briefing = (briefingRows ?? []).find((row: any) => findAsk(row.payload, askId));
    if (!briefing) return json({ error: "briefing_ask_not_found" }, 404);
    const ask = normalizeAskMetadata(briefing, findAsk((briefing as any).payload, askId), assignee);
    const responseHash = await sha256(`${askId}:${threadId}:${therapistResponse}`);
    const targetType = String(ask?.target_type ?? "none");
    const targetItemId = ask?.target_item_id ? String(ask.target_item_id) : null;
    const resolutionMode = String(body.resolution_mode ?? ((ask?.expected_resolution === "update_program" || ask?.requires_immediate_program_update) ? "apply_to_program" : "store_observation"));
    const decisionBeforeApply = buildDecision(ask, therapistResponse, resolutionMode);

    let existingQuery = admin
      .from("briefing_ask_resolutions")
      .select("*")
      .eq("user_id", userId)
      .eq("briefing_id", briefing.id)
      .eq("ask_id", askId)
      .eq("thread_id", threadId)
      .eq("target_type", targetType)
      .eq("response_hash", responseHash);
    existingQuery = targetItemId ? existingQuery.eq("target_item_id", targetItemId) : existingQuery.is("target_item_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing?.processed_at) return json({ resolution: existing, reused: true });

    const baseResolution = {
      user_id: userId,
      briefing_id: briefing.id,
      ask_id: askId,
      thread_id: threadId,
      assignee,
      therapist_response: therapistResponse,
      response_hash: responseHash,
      intent: ask?.intent ?? "none",
      target_type: targetType,
      target_item_id: targetItemId,
      target_item_key: targetItemId ?? stableTargetKey(briefing.id, targetType, ask?.target_part_name ?? null),
      target_part_name: ask?.target_part_name ?? null,
      resolution_mode: resolutionMode,
      resolution_status: "pending",
      decision_before_apply: decisionBeforeApply,
      decision: decisionBeforeApply.decision,
      confidence: decisionBeforeApply.confidence,
      requires_reapproval: decisionBeforeApply.requires_reapproval,
      clinical_caution: decisionBeforeApply.clinical_caution,
      evidence_level: decisionBeforeApply.evidence_level,
    };
    const { data: inserted, error: insertErr } = await admin.from("briefing_ask_resolutions").insert(baseResolution).select("*").maybeSingle();
    if (insertErr && !existing) throw insertErr;
    let resolutionId = inserted?.id ?? existing?.id;

    if (resolutionMode === "apply_to_program" && (targetType === "proposed_playroom" || targetType === "proposed_session")) {
      const prefill = buildProgramPrefill((briefing as any).payload, ask, assignee);
      if (!prefill) return json({ error: "target_prefill_missing" }, 400);
      const createRes = await fetch(`${SUPABASE_URL}/functions/v1/karel-team-deliberation-create`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          deliberation_type: "session_plan",
          subject_parts: [ask.target_part_name].filter(Boolean),
          reason: prefill.reason,
          hint: prefill.title,
          priority: "high",
          linked_briefing_id: briefing.id,
          linked_briefing_item_id: targetItemId || askId,
          prefill,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok || !created?.deliberation?.id) throw new Error(created?.error || "deliberation_create_failed");
      const question = String(ask?.text ?? ask?.question_text ?? "");
      const { data: beforeDelib } = await admin.from("did_team_deliberations").select("program_draft, session_params, status").eq("id", created.deliberation.id).maybeSingle();
      const iterRes = await fetch(`${SUPABASE_URL}/functions/v1/karel-team-deliberation-iterate`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ deliberation_id: created.deliberation.id, latest_input: { author: assignee, text: therapistResponse, question, briefing_ask_resolution: decisionBeforeApply } }),
      });
      const iter = await iterRes.json();
      if (!iterRes.ok) throw new Error(iter?.error || "iterate_failed");
      const { data: afterDelib } = await admin.from("did_team_deliberations").select("program_draft, session_params, status").eq("id", created.deliberation.id).maybeSingle();
      const programDiff = { before: beforeDelib?.program_draft ?? [], after: afterDelib?.program_draft ?? [], changed_blocks: Array.isArray(afterDelib?.program_draft) ? afterDelib.program_draft.map((b: any) => String(b?.block ?? "")).filter(Boolean) : [], summary: iter?.karel_inline_comment ?? null };
      const sessionParamsDiff = { before: beforeDelib?.session_params ?? {}, after: afterDelib?.session_params ?? {}, changed_keys: changedKeys(beforeDelib?.session_params ?? {}, afterDelib?.session_params ?? {}), risk_gate_changed: JSON.stringify(beforeDelib?.session_params?.risk_gate ?? null) !== JSON.stringify(afterDelib?.session_params?.risk_gate ?? null), stop_rules_changed: JSON.stringify(beforeDelib?.session_params?.stop_rules ?? []) !== JSON.stringify(afterDelib?.session_params?.stop_rules ?? []), evidence_limits_changed: true, requires_reapproval: decisionBeforeApply.requires_reapproval };
      const pantry = await appendPantryB(admin as any, { user_id: userId, entry_kind: "plan_change", source_kind: "briefing_ask_resolution", source_ref: `briefing-ask:${briefing.id}:${askId}:${threadId}:${targetType}:${targetItemId ?? "none"}:${responseHash}`, summary: targetType === "proposed_playroom" ? `Odpověď ${assignee === "hanka" ? "Haničky" : "Káti"} byla započítána do programu Herny: diagnostický jazyk převeden na nízkoprahové observační prvky.` : `Odpověď ${assignee === "hanka" ? "Haničky" : "Káti"} byla započítána do programu Sezení a čeká na revizi/podpisy.`, detail: { briefing_id: briefing.id, ask_id: askId, thread_id: threadId, therapist_response: therapistResponse, ...decisionBeforeApply, deliberation_id: created.deliberation.id, program_diff: programDiff, session_params_diff: sessionParamsDiff, evidence_limits: "Závěry až podle konkrétních odpovědí a následného review; žádné pseudo-diagnostické testování." }, intended_destinations: ["briefing_input", "did_implications", "did_therapist_tasks"], related_part_name: ask?.target_part_name ?? undefined, related_therapist: assignee });
      const driveMd = [`## BRIEFING ASK — ZAPOČÍTANÁ ODPOVĚĎ TERAPEUTKY`, `datum: ${new Date().toISOString()}`, `briefing_id: ${briefing.id}`, `ask_id: ${askId}`, `thread_id: ${threadId}`, `odpověděla: ${assignee === "hanka" ? "Hanička" : "Káťa"}`, `část: ${ask?.target_part_name ?? "neurčeno"}`, `target: ${targetType}:${targetItemId ?? "none"}`, `decision: ${decisionBeforeApply.decision}`, `dopad na program: ${programDiff.summary ?? "programová revize vytvořena"}`, `schvalovací stav: čeká na podpis Haničky a Káti`, `evidence limits: Závěry budou možné až podle konkrétních odpovědí a následného review.`, ``, `Odpověď terapeutky: ${therapistResponse}`, ``, `Změněné bloky: ${programDiff.changed_blocks.join(", ") || "nezjištěno"}`].join("\n");
      const { data: pkg } = await admin.from("did_pantry_packages").insert({ user_id: userId, package_type: "briefing_ask_resolution", source_id: pantry?.id ?? null, source_table: "karel_pantry_b_entries", content_md: driveMd, drive_target_path: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN", metadata: { source_kind: "briefing_ask_resolution", briefing_id: briefing.id, ask_id: askId, thread_id: threadId, resolution_id: resolutionId, decision: decisionBeforeApply.decision, target_type: targetType, target_item_id: targetItemId, related_part_name: ask?.target_part_name ?? null }, status: "pending_drive" }).select("id").maybeSingle();
      let driveWriteId: string | null = null;
      if (pkg?.id) {
        try {
          const flushRes = await fetch(`${SUPABASE_URL}/functions/v1/karel-pantry-flush-to-drive`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "scoped", package_ids: [pkg.id] }) });
          const flushed = await flushRes.json().catch(() => ({}));
          driveWriteId = flushed?.results?.[0]?.write_id ?? null;
        } catch (e) { console.warn("[briefing-ask-resolve] drive package flush pending", e); }
      }
      await admin.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).eq("id", threadId);
      const decisionResult = { ...decisionBeforeApply, applied_to_deliberation_id: created.deliberation.id, program_diff: programDiff, session_params_diff: sessionParamsDiff, pantry_entry_id: pantry?.id ?? null, drive_package_id: pkg?.id ?? null, drive_write_id: driveWriteId, resolution_status: "applied_to_program" };
      const patch = {
        resolution_status: "applied_to_program",
        applied_to_deliberation_id: created.deliberation.id,
        applied_to_program_version: new Date().toISOString(),
        applied_to_target_type: targetType,
        applied_to_target_item_id: targetItemId,
        decision_result: decisionResult,
        program_diff: programDiff,
        session_params_diff: sessionParamsDiff,
        pantry_entry_id: pantry?.id ?? null,
        drive_package_id: pkg?.id ?? null,
        drive_write_id: driveWriteId,
        processed_at: new Date().toISOString(),
        processed_by: "karel-briefing-ask-resolve",
      };
      const { data: updated } = await admin.from("briefing_ask_resolutions").update(patch).eq("id", resolutionId).select("*").single();
      return json({ resolution: updated, deliberation: created.deliberation, iteration: iter, decision: decisionResult, program_diff: programDiff, session_params_diff: sessionParamsDiff, status_text: targetType === "proposed_playroom" ? "Odpověď započítána do programu Herny. Změna čeká na podpis Haničky a Káti." : "Odpověď započítána do programu Sezení. Změna čeká na podpis Haničky a Káti." });
    }

    if (resolutionMode === "create_task") {
      const { data: task } = await admin.from("did_therapist_tasks").insert({ user_id: userId, task: therapistResponse || String(ask?.text ?? "Briefingový úkol"), assigned_to: assignee, status: "pending", priority: "normal", source: "briefing_ask" }).select("id").single();
      await appendPantryB(admin as any, { user_id: userId, entry_kind: "followup_need", source_kind: "team_deliberation_answer", source_ref: `briefing_ask:${askId}:${responseHash}`, summary: `Z odpovědi ${assignee === "hanka" ? "Haničky" : "Káti"} vznikl úkol: ${therapistResponse}`, detail: { briefing_id: briefing.id, ask_id: askId, thread_id: threadId }, intended_destinations: ["did_therapist_tasks", "briefing_input"], related_part_name: ask?.target_part_name ?? undefined, related_therapist: assignee });
      const { data: updated } = await admin.from("briefing_ask_resolutions").update({ resolution_status: "created_task", applied_to_target_type: "task", applied_to_target_item_id: task?.id ?? null, processed_at: new Date().toISOString(), processed_by: "karel-briefing-ask-resolve" }).eq("id", resolutionId).select("*").single();
      return json({ resolution: updated, task_id: task?.id, status_text: "Odpověď byla převedena na úkol." });
    }

    await appendPantryB(admin as any, { user_id: userId, entry_kind: resolutionMode === "close_no_change" ? "conclusion" : "followup_need", source_kind: "team_deliberation_answer", source_ref: `briefing_ask:${askId}:${responseHash}`, summary: resolutionMode === "close_no_change" ? `Briefingový bod uzavřen bez změny programu: ${String(ask?.text ?? "")}` : `Odpověď ${assignee === "hanka" ? "Haničky" : "Káti"} k briefingovému bodu: ${therapistResponse}`, detail: { briefing_id: briefing.id, ask_id: askId, thread_id: threadId, question: ask?.text ?? ask?.question_text, answer: therapistResponse }, intended_destinations: ["briefing_input", "did_implications"], related_part_name: ask?.target_part_name ?? undefined, related_therapist: assignee });
    await admin.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).eq("id", threadId);
    const status = resolutionMode === "close_no_change" ? "closed_no_change" : "stored_as_observation";
    const { data: updated } = await admin.from("briefing_ask_resolutions").update({ resolution_status: status, processed_at: new Date().toISOString(), processed_by: "karel-briefing-ask-resolve" }).eq("id", resolutionId).select("*").single();
    return json({ resolution: updated, status_text: status === "closed_no_change" ? "Bod byl uzavřen bez změny programu." : "Odpověď byla uložena jako operační pozorování." });
  } catch (e) {
    console.error("[karel-briefing-ask-resolve] fatal", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
