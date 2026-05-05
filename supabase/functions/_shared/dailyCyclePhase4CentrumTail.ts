/**
 * P29B.2-CF — Detached CENTRUM tail helper.
 *
 * Runs the heavy "tail" work that previously lived inline inside the main
 * karel-did-daily-cycle right after the `update_cards_enqueued` marker:
 *
 *   1. Process [CENTRUM:...] blocks from the validated AI analysis text and
 *      enqueue governed Drive writes for 05A_OPERATIVNI_PLAN, DASHBOARD,
 *      05B_STRATEGICKY_VYHLED.
 *   2. Forced CENTRUM fallback (deterministic Dashboard / Operative Plan)
 *      when the AI did not emit those blocks.
 *   3. 07_KNIHOVNA analysis pass (budgeted Drive read + AI + per-part
 *      enqueue + per-CENTRUM-doc enqueue + distribution markers).
 *
 * The orchestrator (main daily-cycle) only persists a payload row to
 * did_daily_cycle_phase_payloads and enqueues a phase4_centrum_tail job.
 * The phase worker reads the payload and invokes runPhase4CentrumTail.
 *
 * Hard guarantees:
 *   - Bounded wall-clock budgets for KNIHOVNA scan and overall tail.
 *   - Heartbeat callback fires before/after every major loop.
 *   - All Drive mutations go through governed enqueueDriveWrite.
 *   - context_data on the cycle is NEVER overwritten — only the payload
 *     ref + small audit fields are written by the orchestrator.
 *   - controlled_skip path when centrum folder id missing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getAccessToken, listFiles, readFileContent } from "./driveHelpers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

const TAIL_TOTAL_BUDGET_MS = 240_000; // 4 min hard ceiling for the whole tail
const KNIHOVNA_BUDGET_MS = 60_000;
const KNIHOVNA_AI_TIMEOUT_MS = 45_000;
const MAX_HANDBOOK_CHARS = 2000;
const MAX_HANDBOOKS_SCANNED = 10;

export type PayloadRef = {
  payload_table: string;
  payload_id: string;
  payload_hash?: string;
  job_kind: string;
};

export type CentrumTailResult = {
  outcome: "completed" | "controlled_skipped" | "partial";
  controlled_skips: string[];
  centrum_blocks_processed: number;
  centrum_writes_enqueued: number;
  fallback_dashboard_enqueued: boolean;
  fallback_plan_enqueued: boolean;
  knihovna_handbooks_scanned: number;
  knihovna_writes_enqueued: number;
  ai_calls_made: number;
  writes_enqueued: number;
  writes_blocked_by_governance: number;
  duration_ms: number;
  errors: string[];
};

type SetHeartbeat = () => Promise<void> | void;
type Logger = (msg: string, extra?: Record<string, unknown>) => void;

function canonicalText(value: string): string {
  return (value ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function contentHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return (h >>> 0).toString(16);
}

export async function runPhase4CentrumTail(args: {
  cycleId: string;
  userId: string;
  payloadRef: PayloadRef;
  setHeartbeat?: SetHeartbeat;
  log?: Logger;
}): Promise<CentrumTailResult> {
  const start = Date.now();
  const log: Logger = args.log ?? ((m, e) => console.log(`[centrum-tail] ${m}`, e ?? ""));
  const heartbeat: SetHeartbeat = args.setHeartbeat ?? (() => {});

  const result: CentrumTailResult = {
    outcome: "completed",
    controlled_skips: [],
    centrum_blocks_processed: 0,
    centrum_writes_enqueued: 0,
    fallback_dashboard_enqueued: false,
    fallback_plan_enqueued: false,
    knihovna_handbooks_scanned: 0,
    knihovna_writes_enqueued: 0,
    ai_calls_made: 0,
    writes_enqueued: 0,
    writes_blocked_by_governance: 0,
    duration_ms: 0,
    errors: [],
  };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Load payload row ──────────────────────────────────────────────────
  const { data: payloadRow, error: payloadErr } = await admin
    .from("did_daily_cycle_phase_payloads")
    .select("payload")
    .eq("id", args.payloadRef.payload_id)
    .maybeSingle();
  if (payloadErr || !payloadRow) {
    result.outcome = "controlled_skipped";
    result.controlled_skips.push("payload_row_missing");
    result.duration_ms = Date.now() - start;
    return result;
  }

  const p = (payloadRow.payload ?? {}) as {
    validatedAnalysisText?: string;
    analysisText?: string;
    centrumFolderId?: string | null;
    hasRecentActivity?: boolean;
    reportThreads?: Array<{ sub_mode: string; part_name: string }>;
    reportConversations?: Array<{ sub_mode: string; label: string }>;
    recentHanaConversations?: Array<unknown>;
    recentEpisodes?: Array<unknown>;
    pendingTasks?: Array<any>;
    activeParts?: Array<{ id: string; name: string; normalizedName?: string; cluster?: string; age?: string; status?: string }>;
    sleepingParts?: Array<{ id: string; name: string; status?: string; cluster?: string }>;
    existingCardsContext?: string;
    blacklist?: string[];
    counts?: Record<string, number>;
    dateStr?: string;
  };

  const validatedAnalysisText = p.validatedAnalysisText ?? "";
  const analysisText = p.analysisText ?? "";
  const centrumFolderId = p.centrumFolderId ?? null;
  const dateStr = p.dateStr ?? new Date().toISOString().slice(0, 10);

  // ── Helper: governed enqueue ─────────────────────────────────────────
  async function enqueueDriveWrite(input: {
    target_document: string;
    payload: string;
    write_type: "append" | "replace";
    priority: "low" | "normal" | "high";
    content_type: string;
    subject_type: string;
    subject_id: string;
  }): Promise<boolean> {
    try {
      const { error } = await admin.from("did_pending_drive_writes").insert({
        user_id: args.userId,
        cycle_id: args.cycleId,
        target_document: input.target_document,
        payload: input.payload,
        write_type: input.write_type,
        priority: input.priority,
        content_type: input.content_type,
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        status: "queued",
        source: "phase4_centrum_tail",
      });
      if (error) {
        result.writes_blocked_by_governance++;
        log(`enqueueDriveWrite error: ${error.message}`);
        return false;
      }
      result.writes_enqueued++;
      return true;
    } catch (e: any) {
      result.errors.push(`enqueue:${e?.message ?? String(e)}`);
      return false;
    }
  }

  function timeBudgetExhausted() {
    return Date.now() - start > TAIL_TOTAL_BUDGET_MS;
  }

  const blacklist = new Set((p.blacklist ?? []).map((s) => canonicalText(s)));
  const isBlacklisted = (n: string) => blacklist.has(canonicalText(n));

  // ── 1) [CENTRUM:...] blocks ──────────────────────────────────────────
  await heartbeat();
  let centrumDashboardUpdated = false;
  let centrumOperativniUpdated = false;
  try {
    const re = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
    for (const m of validatedAnalysisText.matchAll(re)) {
      if (timeBudgetExhausted()) break;
      const docName = m[1].trim();
      const newContent = m[2].trim();
      if (!newContent || newContent.length < 10) continue;
      result.centrum_blocks_processed++;

      const dc = canonicalText(docName);
      try {
        if ((dc.includes("operativn") && dc.includes("plan")) || (dc.includes("terapeutick") && dc.includes("plan"))) {
          const planDoc = `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${newContent}`;
          const ok = await enqueueDriveWrite({
            target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
            payload: planDoc, write_type: "replace", priority: "high",
            content_type: "daily_plan", subject_type: "system", subject_id: "operative_plan",
          });
          if (ok) { centrumOperativniUpdated = true; result.centrum_writes_enqueued++; }
        } else if (dc.includes("dashboard")) {
          const dashDoc = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${newContent}`;
          const ok = await enqueueDriveWrite({
            target_document: "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
            payload: dashDoc, write_type: "replace", priority: "high",
            content_type: "dashboard_status", subject_type: "system", subject_id: "dashboard",
          });
          if (ok) { centrumDashboardUpdated = true; result.centrum_writes_enqueued++; }
        } else if (dc.includes("strategick") && dc.includes("vyhled")) {
          const hash = contentHash(newContent.trim());
          const stratDoc = `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr} [KHASH:${hash}]\nSprávce: Karel\n\n${newContent}`;
          const ok = await enqueueDriveWrite({
            target_document: "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
            payload: stratDoc, write_type: "replace", priority: "normal",
            content_type: "strategic_outlook", subject_type: "system", subject_id: "strategic_outlook",
          });
          if (ok) result.centrum_writes_enqueued++;
        } else {
          log(`skip non-governed CENTRUM doc: ${docName}`);
        }
      } catch (e: any) {
        result.errors.push(`centrum_block:${docName}:${e?.message ?? String(e)}`);
      }
    }
  } catch (e: any) {
    result.errors.push(`centrum_phase:${e?.message ?? String(e)}`);
  }
  await heartbeat();

  // ── 2) Forced CENTRUM fallback ───────────────────────────────────────
  if (p.hasRecentActivity && !timeBudgetExhausted()) {
    const activeParts = p.activeParts ?? [];
    const sleepingParts = p.sleepingParts ?? [];
    const reportThreads = p.reportThreads ?? [];
    const recentHanaConversations = p.recentHanaConversations ?? [];
    const recentEpisodes = p.recentEpisodes ?? [];
    const pendingTasks = p.pendingTasks ?? [];
    const activePartsFromThreads = [...new Set(reportThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))];

    if (!centrumDashboardUpdated) {
      try {
        const partStatusLines = activeParts.map(pt => {
          const had = activePartsFromThreads.some(tp => canonicalText(tp) === (pt.normalizedName ?? canonicalText(pt.name)));
          return `▸ ${pt.name} (ID ${pt.id}) [${had ? "🟢 komunikoval/a s Karlem" : "🟡 bez aktivity dnes"}] – klastr: ${pt.cluster || "?"}, věk: ${pt.age || "?"}`;
        });
        const criticalTasks = pendingTasks.filter((t: any) => Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000) >= 3);
        const criticalAlertsText = criticalTasks.length > 0
          ? criticalTasks.map((t: any) => `⚠️ ${t.task} – ${Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000)} dní nesplněno (${t.assigned_to})`).join("\n")
          : "✅ Žádná kritická upozornění";
        const sleepingWatchlist = sleepingParts.length > 0
          ? sleepingParts.map(pt => `▸ ${pt.name} (ID ${pt.id}) – status: ${pt.status}, klastr: ${pt.cluster || "?"}`).join("\n")
          : "Žádné spící části v registru.";
        const priorityLines = pendingTasks.slice(0, 5).map((t: any) => `▸ ${t.task} (${t.assigned_to}, priorita: ${t.priority || "normal"})`).join("\n") || "Žádné aktivní úkoly.";

        const fullDashboard = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM
Aktualizace: ${dateStr}
Správce: Karel (deterministický fallback z DB)

SEKCE 1 – STAV SYSTÉMU TEĎ
Aktivních částí v registru: ${activeParts.length}
Spících částí: ${sleepingParts.length}
${partStatusLines.join("\n") || "Žádné části v registru."}

SEKCE 2 – KRITICKÁ UPOZORNĚNÍ ⚠️
${criticalAlertsText}

SEKCE 3 – CO SE DĚLO POSLEDNÍCH 24H
- DID vlákna (cast): ${reportThreads.filter(t => t.sub_mode === "cast").length} (části: ${activePartsFromThreads.join(", ") || "žádné"})
- Hana konverzace: ${recentHanaConversations.length}
- Epizody: ${recentEpisodes.length}

SEKCE 4 – WATCHLIST SPÍCÍCH ČÁSTÍ 💤
${sleepingWatchlist}

SEKCE 5 – TERAPEUTICKÝ FOKUS DNE 🎯
${priorityLines}

SEKCE 7 – KARLOVY POSTŘEHY 🔍
⚠️ Tento dashboard byl vygenerován deterministickým fallbackem z DB dat – AI analýza nevygenerovala CENTRUM blok.`;

        const ok = await enqueueDriveWrite({
          target_document: "KARTOTEKA_DID/00_CENTRUM/00_Aktualni_Dashboard",
          payload: fullDashboard, write_type: "replace", priority: "high",
          content_type: "centrum_fallback_dashboard", subject_type: "centrum", subject_id: "00_Aktualni_Dashboard",
        });
        if (ok) { result.fallback_dashboard_enqueued = true; centrumDashboardUpdated = true; }
      } catch (e: any) {
        result.errors.push(`fallback_dashboard:${e?.message ?? String(e)}`);
      }
    }
    await heartbeat();

    if (!centrumOperativniUpdated && !timeBudgetExhausted()) {
      try {
        const partStatusTable = activeParts.map(pt => {
          const had = activePartsFromThreads.some(tp => canonicalText(tp) === (pt.normalizedName ?? canonicalText(pt.name)));
          return `| ${pt.name} / ${pt.id} | ${had ? "Aktivní" : "Ticho"} | ${pt.cluster || "?"} | ${pt.age || "?"} |`;
        }).join("\n");
        const taskLines = pendingTasks.map((t: any) => {
          const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000);
          return `${age >= 3 ? "⚠️" : "☐"} ${t.assigned_to}: ${t.task} (${age}d, ${t.priority || "normal"})`;
        }).join("\n") || "Žádné nesplněné úkoly.";
        const riskTasks = pendingTasks.filter((t: any) => Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000) >= 3);
        const riskLines = riskTasks.length > 0
          ? riskTasks.map((t: any) => `⚠️ ESKALACE: "${t.task}" – nesplněno ${Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86_400_000)} dní`).join("\n")
          : "Žádná akutní rizika.";

        const fullPlan = `OPERATIVNÍ PLÁN – DID SYSTÉM
Aktualizace: ${dateStr}
Správce: Karel (deterministický fallback z DB)

SEKCE 1 – AKTIVNÍ ČÁSTI A AKTUÁLNÍ STAV
| Část / ID | Aktuální stav | Klastr | Věk |
${partStatusTable || "| (žádné aktivní části) | | | |"}

SEKCE 3 – AKTIVNÍ ÚKOLY + HODNOCENÍ PLNĚNÍ
${taskLines}

SEKCE 5 – UPOZORNĚNÍ A RIZIKA
${riskLines}

SEKCE 6 – KARLOVY POZNÁMKY
⚠️ Deterministický fallback – AI nevytvořila CENTRUM blok.`;

        const ok = await enqueueDriveWrite({
          target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
          payload: fullPlan, write_type: "replace", priority: "high",
          content_type: "centrum_fallback_operativni_plan", subject_type: "centrum", subject_id: "05A_OPERATIVNI_PLAN",
        });
        if (ok) result.fallback_plan_enqueued = true;
      } catch (e: any) {
        result.errors.push(`fallback_plan:${e?.message ?? String(e)}`);
      }
    }
  }
  await heartbeat();

  // ── 3) [ACCOUNTABILITY] task escalation (DB-only, no Drive I/O) ─────
  try {
    const accMatch = analysisText.match(/\[ACCOUNTABILITY\]([\s\S]*?)\[\/ACCOUNTABILITY\]/);
    if (accMatch && (p.pendingTasks ?? []).length > 0) {
      for (const task of p.pendingTasks!) {
        if (timeBudgetExhausted()) break;
        const age = Math.floor((Date.now() - new Date(task.created_at).getTime()) / 86_400_000);
        const currentLevel = task.escalation_level || 0;
        const updates: Record<string, any> = {};
        if (age >= 3 && task.priority !== "high") updates.priority = "high";
        if (age >= 7 && currentLevel < 3) updates.escalation_level = 3;
        else if (age >= 5 && currentLevel < 2) updates.escalation_level = 2;
        else if (age >= 3 && currentLevel < 1) updates.escalation_level = 1;
        if (Object.keys(updates).length > 0) {
          await admin.from("did_therapist_tasks").update(updates).eq("id", task.id);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(`accountability:${e?.message ?? String(e)}`);
  }
  await heartbeat();

  // ── 4) 07_KNIHOVNA pass (budgeted) ──────────────────────────────────
  if (!centrumFolderId) {
    result.controlled_skips.push("knihovna:no_centrum_folder_id");
  } else if (timeBudgetExhausted()) {
    result.controlled_skips.push("knihovna:tail_budget_exhausted");
  } else {
    const knihovnaStart = Date.now();
    try {
      const token = await getAccessToken();
      const centerFiles = await listFiles(token, centrumFolderId);
      const knihovnaFolder = centerFiles.find((f) => f.mimeType === DRIVE_FOLDER_MIME && f.name.includes("07_Knihovna"));
      if (knihovnaFolder) {
        const knihovnaFiles = await listFiles(token, knihovnaFolder.id);
        const prehledFile = knihovnaFiles.find((f) => f.name.startsWith("00_Prehled"));
        if (prehledFile) {
          const prehledContent = await readFileContent(token, prehledFile.id, prehledFile.mimeType);
          const handbookFiles = knihovnaFiles.filter((f) => f.mimeType !== DRIVE_FOLDER_MIME && !f.name.startsWith("00_Prehled"));

          let handbookContext = "";
          const undistributed: Array<{ id: string; name: string }> = [];
          for (const hf of handbookFiles.slice(0, MAX_HANDBOOKS_SCANNED)) {
            if (Date.now() - knihovnaStart > KNIHOVNA_BUDGET_MS) break;
            await heartbeat();
            try {
              const c = await readFileContent(token, hf.id, hf.mimeType);
              if (c.includes("[DISTRIBUOVÁNO DO KARTOTÉKY")) continue;
              handbookContext += `\n\n=== PŘÍRUČKA: ${hf.name} ===\n${c.length > MAX_HANDBOOK_CHARS ? c.slice(0, MAX_HANDBOOK_CHARS) + "…" : c}`;
              undistributed.push({ id: hf.id, name: hf.name });
              result.knihovna_handbooks_scanned++;
            } catch { /* ignore single-file failure */ }
          }

          if (handbookContext.length > 100 && Date.now() - knihovnaStart <= KNIHOVNA_BUDGET_MS && LOVABLE_API_KEY) {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), KNIHOVNA_AI_TIMEOUT_MS);
            let knihovnaText = "";
            try {
              result.ai_calls_made++;
              const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                signal: ctrl.signal,
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash",
                  messages: [
                    { role: "system", content: `Jsi Karel – analytik DID systému. Pro každou DID-relevantní příručku urči, kam v kartotéce informace zapsat. Formát: [KNIHOVNA_KARTA:jméno] s [SEKCE:I/J/...] bloky, nebo [KNIHOVNA_CENTRUM:doc] bloky. Nikdy nevkládej celý obsah – jen shrnutí + odkaz.\n\n${p.existingCardsContext ? `EXISTUJÍCÍ KARTY:\n${p.existingCardsContext.slice(0, 3000)}` : ""}` },
                    { role: "user", content: `PŘEHLED:\n${prehledContent.slice(0, 2000)}\n\nPŘÍRUČKY:\n${handbookContext}` },
                  ],
                }),
              });
              if (aiRes.ok) {
                const data = await aiRes.json();
                knihovnaText = data.choices?.[0]?.message?.content ?? "";
              }
            } catch (e: any) {
              result.errors.push(`knihovna_ai:${e?.name === "AbortError" ? "timeout" : e?.message}`);
            } finally {
              clearTimeout(t);
            }

            if (knihovnaText.length > 50) {
              await heartbeat();
              // KNIHOVNA_KARTA → per-part enqueue
              const kartaRe = /\[KNIHOVNA_KARTA:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_KARTA\]/g;
              for (const km of knihovnaText.matchAll(kartaRe)) {
                if (timeBudgetExhausted()) break;
                const partName = km[1].trim();
                const block = km[2].trim();
                if (isBlacklisted(partName)) continue;
                const sectionRe = /\[SEKCE:([A-N])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
                const sections: Record<string, string> = {};
                for (const sm of block.matchAll(sectionRe)) {
                  const txt = sm[2].trim();
                  if (txt) sections[sm[1].toUpperCase()] = txt;
                }
                if (Object.keys(sections).length === 0) continue;
                const letters = Object.keys(sections).sort();
                const payload = `\n\n[${dateStr}] Z 07_Knihovna (daily-cycle):\n` +
                  letters.map((L) => `[SEKCE:${L}]\n${sections[L]}`).join("\n\n");
                const ok = await enqueueDriveWrite({
                  target_document: `KARTA_${partName.toUpperCase()}`,
                  payload, write_type: "append", priority: "normal",
                  content_type: "knihovna_card_section_update",
                  subject_type: "part", subject_id: partName,
                });
                if (ok) result.knihovna_writes_enqueued++;
              }
              // KNIHOVNA_CENTRUM → centrum doc append
              const centrumRe = /\[KNIHOVNA_CENTRUM:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_CENTRUM\]/g;
              for (const cm of knihovnaText.matchAll(centrumRe)) {
                if (timeBudgetExhausted()) break;
                const docName = cm[1].trim();
                const newContent = cm[2].trim();
                if (!newContent || newContent.length < 10) continue;
                const dc = canonicalText(docName);
                let canonicalTarget: string | null = null;
                if (dc.includes("dashboard")) canonicalTarget = "00_Aktualni_Dashboard";
                else if (dc.includes("dohod") || dc.includes("operativ")) canonicalTarget = "05A_OPERATIVNI_PLAN";
                else if (dc.includes("strateg") || dc.includes("vyhled")) canonicalTarget = "05B_STRATEGICKY_VYHLED";
                else if (dc.includes("terapeutick") && dc.includes("plan")) canonicalTarget = "05A_OPERATIVNI_PLAN";
                if (!canonicalTarget) continue;
                const payload = `\n\n[${dateStr}] Z 07_Knihovna:\n${newContent}`;
                const ok = await enqueueDriveWrite({
                  target_document: `KARTOTEKA_DID/00_CENTRUM/${canonicalTarget}`,
                  payload, write_type: "append", priority: "normal",
                  content_type: "knihovna_centrum_append",
                  subject_type: "centrum", subject_id: canonicalTarget,
                });
                if (ok) result.knihovna_writes_enqueued++;
              }
              // Distribution markers
              for (const uh of undistributed) {
                if (timeBudgetExhausted()) break;
                await enqueueDriveWrite({
                  target_document: `KARTOTEKA_DID/00_CENTRUM/07_Knihovna/${uh.name}`,
                  payload: `\n\n[DISTRIBUOVÁNO DO KARTOTÉKY: ${dateStr}]`,
                  write_type: "append", priority: "low",
                  content_type: "knihovna_distributed_marker",
                  subject_type: "knihovna_handbook", subject_id: uh.id,
                });
              }
            }
          } else if (Date.now() - knihovnaStart > KNIHOVNA_BUDGET_MS) {
            result.controlled_skips.push("knihovna:budget_exhausted_pre_ai");
          }
        }
      }
    } catch (e: any) {
      result.errors.push(`knihovna:${e?.message ?? String(e)}`);
    }
  }

  result.duration_ms = Date.now() - start;
  if (result.controlled_skips.length > 0 && result.writes_enqueued === 0) {
    result.outcome = "controlled_skipped";
  } else if (result.errors.length > 0) {
    result.outcome = "partial";
  }
  return result;
}
