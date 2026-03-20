/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Memory Mirror – Masivní analytický engine
 * 
 * Při spuštění:
 * 1) Zjistí čas posledního zrcadlení → scope = vše od té doby
 * 2) Naskenuje VŠECHNA vlákna/konverzace ze VŠECH režimů v tom rozsahu
 * 3) Načte VŠECHNY dokumenty ze VŠECH 3 Drive složek (PAMET_KAREL, KARTOTEKA_DID, ZALOHA)
 * 4) AI Pass 1 (Gemini 2.5 Pro): Extrakce surových faktů, jmen, událostí, emocí
 * 5) AI Pass 2 (Gemini 2.5 Pro): Hloubková syntéza – cross-reference s Drive, inferování
 *    skrytých emocí, navrhování úkolů, doporučení sezení
 * 6) Zápis do DB (entity, vzorce, strategie, úkoly)
 * 7) Zápis na Drive (PAMET_KAREL, KARTOTEKA_DID, ZALOHA)
 *
 * DEDUP: KHASH, concurrency lock, DB upsert
 */

// ── Content hash (FNV-1a 32bit) ──
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ── OAuth2 ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive helpers ──
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFolderFuzzy(token: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

async function findDoc(token: string, pattern: string, parentId: string): Promise<{ id: string; name: string } | null> {
  const q = `name contains '${pattern}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function readDoc(token: string, fileId: string): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "";
  return await res.text();
}

async function updateDoc(token: string, docId: string, content: string): Promise<void> {
  const boundary = "===redistribute_boundary===";
  const body = [
    `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({}),
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", content, `--${boundary}--`,
  ].join("\r\n");
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Failed to update doc ${docId}: ${await res.text()}`);
}

async function listAllFilesRecursive(token: string, folderId: string, prefix = ""): Promise<Array<{ id: string; name: string; path: string; isFolder: boolean }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const files = data.files || [];
  const result: Array<{ id: string; name: string; path: string; isFolder: boolean }> = [];
  
  for (const f of files) {
    const isFolder = f.mimeType === "application/vnd.google-apps.folder";
    const path = prefix ? `${prefix}/${f.name}` : f.name;
    result.push({ id: f.id, name: f.name, path, isFolder });
    if (isFolder) {
      const children = await listAllFilesRecursive(token, f.id, path);
      result.push(...children);
    }
  }
  return result;
}

// ── Auth ──
function isCronOrService(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") || "";
  const ua = req.headers.get("User-Agent") || "";
  if (authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__")) return true;
  if (ua.startsWith("pg_net/") || ua.startsWith("Supabase Edge Functions")) return true;
  return false;
}

// ── AI call helper ──
async function callAI(apiKey: string, systemPrompt: string, userPrompt: string, model = "google/gemini-2.5-pro"): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.15,
    }),
  });
  if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function extractJSON(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

type MirrorState = {
  entityIndex: number;
  patternIndex: number;
  strategyIndex: number;
  relationIndex: number;
  taskIndex: number;
  semanticDriveDone: boolean;
  proceduralDriveDone: boolean;
  episodesDriveDone: boolean;
  therapistProfileDriveDone: boolean;
  partUpdateIndex: number;
  newPartIndex: number;
  centrumIndex: number;
  clientUpdateIndex: number;
  dbUpdates: string[];
  driveUpdates: string[];
};

const MIRROR_BATCH = {
  entities: 5,
  patterns: 5,
  strategies: 5,
  relations: 10,
  tasks: 5,
  partUpdates: 2,
  newParts: 1,
  centrum: 1,
  clients: 2,
};

function createInitialMirrorState(): MirrorState {
  return {
    entityIndex: 0,
    patternIndex: 0,
    strategyIndex: 0,
    relationIndex: 0,
    taskIndex: 0,
    semanticDriveDone: false,
    proceduralDriveDone: false,
    episodesDriveDone: false,
    therapistProfileDriveDone: false,
    partUpdateIndex: 0,
    newPartIndex: 0,
    centrumIndex: 0,
    clientUpdateIndex: 0,
    dbUpdates: [],
    driveUpdates: [],
  };
}

function buildCentrumWrites(extractedInfo: any): Array<{ pattern: string; content: string; label: string; rewrite: boolean }> {
  const cu = extractedInfo?.centrum_updates;
  if (!cu) return [];

  const writes: Array<{ pattern: string; content: string; label: string; rewrite: boolean }> = [];
  // Dashboard and Operativni Plan are FULL REWRITE (same as daily cycle)
  if (cu.dashboard_full) writes.push({ pattern: "Dashboard", content: cu.dashboard_full, label: "Dashboard", rewrite: true });
  else if (cu.dashboard_notes) writes.push({ pattern: "Dashboard", content: cu.dashboard_notes, label: "Dashboard", rewrite: true });
  if (cu.operative_plan_full) writes.push({ pattern: "Operativn", content: cu.operative_plan_full, label: "Operativni_Plan", rewrite: true });
  else if (cu.operative_plan_notes) writes.push({ pattern: "Operativn", content: cu.operative_plan_notes, label: "Operativni_Plan", rewrite: true });
  // Geography and Relationships are APPEND
  if (cu.geography_notes) writes.push({ pattern: "Geografie", content: cu.geography_notes, label: "Geografie", rewrite: false });
  if (cu.relationships_notes) writes.push({ pattern: "Vztah", content: cu.relationships_notes, label: "Mapa_Vztahu", rewrite: false });
  return writes;
}

function buildClientUpdates(extractedInfo: any): Array<[string, string]> {
  return Object.entries(extractedInfo?.zaloha?.client_updates || {}).filter(
    ([, content]) => typeof content === "string" && content.length > 0,
  ) as Array<[string, string]>;
}

function getMirrorProgress(payload: any, rawState?: Partial<MirrorState>) {
  const state = { ...createInitialMirrorState(), ...(rawState || {}) } as MirrorState;
  const extractedInfo = payload?.extractedInfo || {};
  const entityUpdates = extractedInfo?.pamet_karel?.entity_updates || [];
  const patternUpdates = extractedInfo?.pamet_karel?.pattern_updates || [];
  const strategyUpdates = extractedInfo?.pamet_karel?.strategy_updates || [];
  const relationUpdates = extractedInfo?.pamet_karel?.relation_updates || [];
  const taskUpdates = extractedInfo?.new_tasks || [];
  const partUpdates = Object.entries(extractedInfo?.kartoteka_did?.part_updates || {}).filter(
    ([, content]) => typeof content === "string" && content.length > 0,
  );
  const newParts = extractedInfo?.kartoteka_did?.new_parts || [];
  const centrumWrites = buildCentrumWrites(extractedInfo);
  const clientUpdates = buildClientUpdates(extractedInfo);

  const total =
    entityUpdates.length +
    patternUpdates.length +
    strategyUpdates.length +
    relationUpdates.length +
    taskUpdates.length +
    3 +
    1 + // therapist profile
    partUpdates.length +
    newParts.length +
    centrumWrites.length +
    clientUpdates.length;

  const completed =
    state.entityIndex +
    state.patternIndex +
    state.strategyIndex +
    state.relationIndex +
    state.taskIndex +
    (state.semanticDriveDone ? 1 : 0) +
    (state.proceduralDriveDone ? 1 : 0) +
    (state.episodesDriveDone ? 1 : 0) +
    (state.therapistProfileDriveDone ? 1 : 0) +
    state.partUpdateIndex +
    state.newPartIndex +
    state.centrumIndex +
    state.clientUpdateIndex;

  return {
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100,
  };
}

async function persistMirrorJob(params: {
  sb: any;
  jobId: string;
  payload: any;
  state: MirrorState;
  phase: string;
  summary: string;
  extra?: Record<string, any>;
}) {
  const { sb, jobId, payload, state, phase, summary, extra = {} } = params;
  await sb.from("karel_memory_logs").update({
    summary,
    updated_at: new Date().toISOString(),
    details: {
      payload,
      state,
      phase,
      progress: getMirrorProgress(payload, state),
      ...extra,
    },
  }).eq("id", jobId);
}

async function finalizeMirrorJob(params: {
  sb: any;
  jobId: string;
  payload: any;
  state: MirrorState;
}) {
  const { sb, jobId, payload, state } = params;
  const {
    startTime,
    lastMirrorTime,
    threadCount,
    driveDocsRead,
    pass1Data,
    extractedInfo,
  } = payload;

  const totalTime = Date.now() - startTime;
  const synthesisSum = extractedInfo?.synthesis_summary || `Mirror: ${state.dbUpdates.length} DB, ${state.driveUpdates.length} Drive`;

  await sb.from("karel_memory_logs").update({
    log_type: "mirror_done",
    summary: synthesisSum,
    updated_at: new Date().toISOString(),
    details: {
      totalMs: totalTime,
      scope: lastMirrorTime,
      phase: "done",
      progress: getMirrorProgress(payload, {
        ...state,
        semanticDriveDone: true,
        proceduralDriveDone: true,
        episodesDriveDone: true,
        therapistProfileDriveDone: true,
      }),
      threadsScanned: threadCount,
      driveDocsRead,
      pass1_facts: pass1Data?.raw_facts?.length || 0,
      pass1_names: pass1Data?.all_names_mentioned?.length || 0,
      pass1_urgent: pass1Data?.urgent_signals || [],
      newPartsCreated: extractedInfo?.kartoteka_did?.new_parts?.length || 0,
      newTasksCreated: extractedInfo?.new_tasks?.length || 0,
      dbUpdates: state.dbUpdates,
      driveUpdates: state.driveUpdates,
    },
  }).eq("id", jobId);

  console.log(`[mirror-batch] DONE in ${totalTime}ms. DB:${state.dbUpdates.length} Drive:${state.driveUpdates.length}`);
}

async function runMirrorBatchStep(params: {
  sb: any;
  userId: string;
  jobId: string;
  payload: any;
  state?: Partial<MirrorState>;
}) {
  const { sb, userId, jobId, payload } = params;
  const extractedInfo = payload?.extractedInfo || {};
  const entities = payload?.entities || [];
  const patterns = payload?.patterns || [];
  const relations = payload?.relations || [];
  const strategies = payload?.strategies || [];
  const activeTasks = payload?.activeTasks || [];
  const episodes = payload?.episodes || [];

  const state: MirrorState = {
    ...createInitialMirrorState(),
    ...(params.state || {}),
    dbUpdates: [...(params.state?.dbUpdates || [])],
    driveUpdates: [...(params.state?.driveUpdates || [])],
  };

  const entityUpdates = extractedInfo?.pamet_karel?.entity_updates || [];
  const patternUpdates = extractedInfo?.pamet_karel?.pattern_updates || [];
  const strategyUpdates = extractedInfo?.pamet_karel?.strategy_updates || [];
  const relationUpdates = extractedInfo?.pamet_karel?.relation_updates || [];
  const taskUpdates = extractedInfo?.new_tasks || [];
  const partUpdates = Object.entries(extractedInfo?.kartoteka_did?.part_updates || {}).filter(
    ([, content]) => typeof content === "string" && content.length > 0,
  ) as Array<[string, string]>;
  const newParts = extractedInfo?.kartoteka_did?.new_parts || [];
  const centrumWrites = buildCentrumWrites(extractedInfo);
  const clientUpdates = buildClientUpdates(extractedInfo);

  try {
    if (state.entityIndex < entityUpdates.length) {
      const batch = entityUpdates.slice(state.entityIndex, state.entityIndex + MIRROR_BATCH.entities);
      for (const eu of batch) {
        const existing = entities.find((e: any) => e.id === eu.id || e.jmeno === eu.jmeno);
        if (existing) {
          const newProps = [...new Set([...(existing.stabilni_vlastnosti || []), ...(eu.new_properties || [])])];
          const newNotes = existing.notes ? `${existing.notes}\n${eu.new_notes || ""}` : (eu.new_notes || "");
          await sb.from("karel_semantic_entities").update({
            stabilni_vlastnosti: newProps,
            notes: newNotes.slice(0, 5000),
            role_vuci_hance: eu.role_vuci_hance || existing.role_vuci_hance,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id).eq("user_id", userId);
          state.dbUpdates.push(`entity_update:${existing.jmeno}`);
        } else if (eu.jmeno) {
          await sb.from("karel_semantic_entities").insert({
            id: eu.id || eu.jmeno.toLowerCase().replace(/\s/g, "_"),
            user_id: userId,
            jmeno: eu.jmeno,
            typ: eu.typ || "clovek",
            role_vuci_hance: eu.role_vuci_hance || "",
            stabilni_vlastnosti: eu.new_properties || [],
            notes: eu.new_notes || "",
          });
          state.dbUpdates.push(`entity_new:${eu.jmeno}`);
        }
      }

      state.entityIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "db_entities", summary: `DB entity batch ${state.entityIndex}/${entityUpdates.length}` });
      return { status: "processing", phase: "db_entities", summary: `DB entity batch ${state.entityIndex}/${entityUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.patternIndex < patternUpdates.length) {
      const batch = patternUpdates.slice(state.patternIndex, state.patternIndex + MIRROR_BATCH.patterns);
      for (const pu of batch) {
        const existing = patterns.find((p: any) => p.id === pu.id);
        if (existing) {
          await sb.from("karel_semantic_patterns").update({
            description: pu.description || existing.description,
            confidence: Math.min(1, Math.max(0, (existing.confidence || 0.5) + (pu.confidence_delta || 0))),
            tags: [...new Set([...(existing.tags || []), ...(pu.tags || [])])],
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id).eq("user_id", userId);
          state.dbUpdates.push(`pattern_update:${pu.id}`);
        } else if (pu.description) {
          await sb.from("karel_semantic_patterns").insert({
            id: pu.id || `pat_${Date.now()}`,
            user_id: userId,
            description: pu.description,
            domain: pu.domain || "HANA",
            tags: pu.tags || [],
            confidence: 0.5,
          });
          state.dbUpdates.push(`pattern_new:${pu.id || "new"}`);
        }
      }

      state.patternIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "db_patterns", summary: `DB patterns ${state.patternIndex}/${patternUpdates.length}` });
      return { status: "processing", phase: "db_patterns", summary: `DB patterns ${state.patternIndex}/${patternUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.strategyIndex < strategyUpdates.length) {
      const batch = strategyUpdates.slice(state.strategyIndex, state.strategyIndex + MIRROR_BATCH.strategies);
      for (const su of batch) {
        const existing = strategies.find((s: any) => s.id === su.id);
        if (existing) {
          await sb.from("karel_strategies").update({
            effectiveness_score: Math.min(1, Math.max(0, (existing.effectiveness_score || 0.5) + (su.effectiveness_delta || 0))),
            guidelines: [...new Set([...(existing.guidelines || []), ...(su.new_guidelines || [])])],
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id).eq("user_id", userId);
          state.dbUpdates.push(`strategy_update:${su.id}`);
        } else if (su.description) {
          await sb.from("karel_strategies").insert({
            id: su.id || `str_${Date.now()}`,
            user_id: userId,
            description: su.description,
            domain: su.domain || "HANA",
            hana_state: su.hana_state || "",
            guidelines: su.new_guidelines || [],
            effectiveness_score: 0.5,
          });
          state.dbUpdates.push(`strategy_new:${su.id || "new"}`);
        }
      }

      state.strategyIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "db_strategies", summary: `DB strategie ${state.strategyIndex}/${strategyUpdates.length}` });
      return { status: "processing", phase: "db_strategies", summary: `DB strategie ${state.strategyIndex}/${strategyUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.relationIndex < relationUpdates.length) {
      const batch = relationUpdates.slice(state.relationIndex, state.relationIndex + MIRROR_BATCH.relations);
      for (const ru of batch) {
        const existing = relations.find((r: any) => r.subject_id === ru.subject_id && r.object_id === ru.object_id && r.relation === ru.relation);
        if (!existing && ru.subject_id && ru.object_id) {
          await sb.from("karel_semantic_relations").insert({
            user_id: userId,
            subject_id: ru.subject_id,
            relation: ru.relation,
            object_id: ru.object_id,
            description: ru.description || "",
          });
          state.dbUpdates.push(`relation_new:${ru.subject_id}->${ru.object_id}`);
        }
      }

      state.relationIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "db_relations", summary: `DB vztahy ${state.relationIndex}/${relationUpdates.length}` });
      return { status: "processing", phase: "db_relations", summary: `DB vztahy ${state.relationIndex}/${relationUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.taskIndex < taskUpdates.length) {
      const batch = taskUpdates.slice(state.taskIndex, state.taskIndex + MIRROR_BATCH.tasks);
      const VALID_ASSIGNEES = new Set(["hanka", "kata", "both"]);
      const VALID_CATEGORIES: Record<string, string> = { today: "today", tomorrow: "tomorrow", longterm: "longterm", general: "general", weekly: "weekly", daily: "daily" };
      const VALID_PRIORITIES: Record<string, string> = { high: "high", normal: "normal", low: "low", vysoká: "high", střední: "normal", nízká: "low" };

      for (const task of batch) {
        if (!task.task) continue;
        const assignee = (task.assigned_to || "").toLowerCase().trim();
        if (!VALID_ASSIGNEES.has(assignee)) {
          state.dbUpdates.push(`task_skip_invalid_assignee:${assignee}:${task.task.slice(0, 40)}`);
          continue;
        }
        const existingTask = activeTasks.find((t: any) => t.task.toLowerCase().includes(task.task.toLowerCase().slice(0, 30)));
        if (existingTask) {
          state.dbUpdates.push(`task_dedup:${task.task.slice(0, 40)}`);
          continue;
        }
        const normalizedCategory = VALID_CATEGORIES[(task.category || "").toLowerCase().trim()] || "general";
        const normalizedPriority = VALID_PRIORITIES[(task.priority || "").toLowerCase().trim()] || "normal";
        const detailInstruction = task.detail_instruction || [
          `Co udělat: ${task.task}`,
          task.reasoning ? `Proč: ${task.reasoning}` : "Další krok: Udělej první konkrétní krok a pak napiš krátký update.",
        ].join("\n");
        await sb.from("did_therapist_tasks").insert({
          user_id: userId,
          task: task.task,
          detail_instruction: detailInstruction,
          assigned_to: assignee,
          priority: normalizedPriority,
          category: normalizedCategory,
          note: task.reasoning || "",
          source_agreement: "mirror_auto",
        });
        state.dbUpdates.push(`task_new:${task.task.slice(0, 40)}`);
      }

      state.taskIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "db_tasks", summary: `DB úkoly ${state.taskIndex}/${taskUpdates.length}` });
      return { status: "processing", phase: "db_tasks", summary: `DB úkoly ${state.taskIndex}/${taskUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (!state.semanticDriveDone) {
      const token = await getAccessToken();
      const pametId = await findFolderFuzzy(token, ["PAMET_KAREL"]);
      if (pametId) {
        const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
        if (semanticId) {
          const [freshEntities, freshPatterns, freshRelations] = await Promise.all([
            sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
            sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
            sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
          ]);

          const [entityDoc, vzorceDoc, vztahyDoc] = await Promise.all([
            findDoc(token, "osoby", semanticId),
            findDoc(token, "vzorce", semanticId),
            findDoc(token, "vztahy", semanticId),
          ]);

          const writes: Promise<void>[] = [];
          if (entityDoc) {
            writes.push(updateDoc(token, entityDoc.id, formatEntities(freshEntities.data || [])));
            state.driveUpdates.push("SEMANTIC/osoby");
          }
          if (vzorceDoc) {
            writes.push(updateDoc(token, vzorceDoc.id, formatPatterns(freshPatterns.data || [])));
            state.driveUpdates.push("SEMANTIC/vzorce");
          }
          if (vztahyDoc) {
            writes.push(updateDoc(token, vztahyDoc.id, formatRelations(freshRelations.data || [])));
            state.driveUpdates.push("SEMANTIC/vztahy");
          }
          await Promise.all(writes);
        }
      }

      state.semanticDriveDone = true;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_semantic", summary: "Drive semantic hotovo" });
      return { status: "processing", phase: "drive_semantic", summary: "Drive semantic hotovo", progress: getMirrorProgress(payload, state) };
    }

    if (!state.proceduralDriveDone) {
      const token = await getAccessToken();
      const pametId = await findFolderFuzzy(token, ["PAMET_KAREL"]);
      if (pametId) {
        const proceduralId = await findFolder(token, "PAMET_KAREL_PROCEDURAL", pametId);
        if (proceduralId) {
          const freshStrategies = await sb.from("karel_strategies").select("*").eq("user_id", userId);
          const stratDoc = await findDoc(token, "strategi", proceduralId);
          if (stratDoc) {
            await updateDoc(token, stratDoc.id, formatStrategies(freshStrategies.data || []));
            state.driveUpdates.push("PROCEDURAL/strategie");
          }
        }
      }

      state.proceduralDriveDone = true;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_procedural", summary: "Drive procedural hotovo" });
      return { status: "processing", phase: "drive_procedural", summary: "Drive procedural hotovo", progress: getMirrorProgress(payload, state) };
    }

    if (!state.episodesDriveDone) {
      const token = await getAccessToken();
      const pametId = await findFolderFuzzy(token, ["PAMET_KAREL"]);
      if (pametId) {
        const episodesId = await findFolder(token, "PAMET_KAREL_EPISODES", pametId);
        if (episodesId) {
          const files = await listAllFilesRecursive(token, episodesId, "");
          const epDoc = files.find((f) => !f.isFolder);
          if (epDoc) {
            await updateDoc(token, epDoc.id, formatEpisodes(episodes.slice(0, 100)));
            state.driveUpdates.push("EPISODES/index");
          }
        }
      }

      state.episodesDriveDone = true;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_episodes", summary: "Drive episodes hotovo" });
      return { status: "processing", phase: "drive_episodes", summary: "Drive episodes hotovo", progress: getMirrorProgress(payload, state) };
    }

    // ═══ THERAPIST PROFILING — write to PAMET_KAREL/DID/[HANKA|KATA] ═══
    if (!state.therapistProfileDriveDone) {
      const therapistProfile = extractedInfo?.pamet_karel?.therapist_situational_profile;
      if (therapistProfile) {
        try {
          const token = await getAccessToken();
          const pametId = await findFolderFuzzy(token, ["PAMET_KAREL"]);
          if (pametId) {
            const didSubfolder = await findFolder(token, "DID", pametId);
            if (didSubfolder) {
              for (const therapist of ["HANKA", "KATA"]) {
                const tKey = therapist === "HANKA" ? "hanka" : "kata";
                const profile = therapistProfile[tKey];
                if (!profile) continue;

                const therapistFolder = await findFolder(token, therapist, didSubfolder);
                if (!therapistFolder) continue;

                // Find SITUACNI_ANALYZA document
                const situacniDoc = await findDoc(token, "SITUACNI_ANALYZA", therapistFolder);
                if (situacniDoc) {
                  const existing = await readDoc(token, situacniDoc.id);
                  const dateStr = new Date().toISOString().slice(0, 10);
                  const hash = contentHash(JSON.stringify(profile));
                  if (!existing.includes(`[KHASH:${hash}]`)) {
                    // Build emotional bonds section if available
                    const bondsText = (profile.part_emotional_bonds || []).length > 0
                      ? `\nCitové vazby k částem:\n${(profile.part_emotional_bonds || []).map((b: any) =>
                          `  ${b.part_name}: ${b.bond_type} – ${b.description}${b.therapeutic_implication ? ` | Terapeutický dopad: ${b.therapeutic_implication}` : ""}`
                        ).join("\n")}`
                      : "";
                    const profileText = `\n\n═══ Situační analýza – ${dateStr} [KHASH:${hash}] ═══
Nálada: ${profile.current_mood || "–"}
Energie: ${profile.energy_level || "–"}
Životní výzvy: ${(profile.life_challenges || []).join(", ") || "–"}
Poslední chování: ${(profile.recent_behaviors || []).join(", ") || "–"}
Doporučený přístup Karla: ${profile.recommended_approach || "–"}${bondsText}`;
                    await updateDoc(token, situacniDoc.id, existing + profileText);
                    state.driveUpdates.push(`PAMET_KAREL/DID/${therapist}/SITUACNI_ANALYZA`);
                  }
                }

                // Find KARLOVY_POZNATKY document
                const poznatkyDoc = await findDoc(token, "KARLOVY_POZNATKY", therapistFolder);
                if (poznatkyDoc && (profile.personality_traits?.length || profile.strengths_observed?.length || profile.weaknesses_observed?.length || profile.part_emotional_bonds?.length)) {
                  const existing = await readDoc(token, poznatkyDoc.id);
                  const insightHash = contentHash(`${dateStr}-insights-${tKey}`);
                  if (!existing.includes(`[KHASH:${insightHash}]`)) {
                    const bondsInsight = (profile.part_emotional_bonds || []).length > 0
                      ? `\nCountertransference vzorce:\n${(profile.part_emotional_bonds || []).map((b: any) =>
                          `  ${b.part_name}: ${b.bond_type} – ${b.description}`
                        ).join("\n")}`
                      : "";
                    const insightText = `\n\n═══ Karlovy postřehy – ${new Date().toISOString().slice(0, 10)} [KHASH:${insightHash}] ═══
Osobnostní rysy: ${(profile.personality_traits || []).join(", ") || "–"}
Silné stránky: ${(profile.strengths_observed || []).join(", ") || "–"}
Slabé stránky: ${(profile.weaknesses_observed || []).join(", ") || "–"}
Aktuální výzvy: ${(profile.current_challenges || []).join(", ") || "–"}
Pozoruhodné chování: ${(profile.notable_behaviors || []).join(", ") || "–"}${bondsInsight}`;
                    await updateDoc(token, poznatkyDoc.id, existing + insightText);
                    state.driveUpdates.push(`PAMET_KAREL/DID/${therapist}/KARLOVY_POZNATKY`);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[mirror] Therapist profile Drive write error:", e);
        }
      }

      state.therapistProfileDriveDone = true;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_therapist_profiles", summary: "Drive profily terapeutek hotovo" });
      return { status: "processing", phase: "drive_therapist_profiles", summary: "Drive profily terapeutek hotovo", progress: getMirrorProgress(payload, state) };
    }

    if (state.partUpdateIndex < partUpdates.length) {
      const token = await getAccessToken();
      const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]);
      const batch = partUpdates.slice(state.partUpdateIndex, state.partUpdateIndex + MIRROR_BATCH.partUpdates);

      if (kartotekaId) {
        for (const [partName, content] of batch) {
          const hash = contentHash(content);
          const searchQ = `name contains '${partName}' and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
          const params = new URLSearchParams({ q: searchQ, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
          const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
          const data = await res.json();
          const partDoc = data.files?.[0];
          if (partDoc) {
            const existing = await readDoc(token, partDoc.id);
            if (existing.includes(`[KHASH:${hash}]`)) {
              state.driveUpdates.push(`KARTOTEKA/${partName} (dedup)`);
              continue;
            }
            await updateDoc(token, partDoc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
            state.driveUpdates.push(`KARTOTEKA/${partName}`);
          }
        }
      }

      state.partUpdateIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_parts", summary: `Drive karty ${state.partUpdateIndex}/${partUpdates.length}` });
      return { status: "processing", phase: "drive_parts", summary: `Drive karty ${state.partUpdateIndex}/${partUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.newPartIndex < newParts.length) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const batch = newParts.slice(state.newPartIndex, state.newPartIndex + MIRROR_BATCH.newParts);

      for (const part of batch) {
        if (!part.name || !part.sections) continue;
        try {
          // Auto-detected parts go to 01_AKTIVNI_FRAGMENTY (active)
          const writeRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-drive-write`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
            body: JSON.stringify({ mode: "update-card-sections", partName: part.name, sections: part.sections, targetFolder: "active" }),
          });
          const writeResult = await writeRes.json();
          if (writeRes.ok && writeResult.success) {
            state.driveUpdates.push(`KARTOTEKA/NEW:${part.name} (01_AKTIVNI)`);
            await sb.from("did_part_registry").upsert({
              user_id: userId,
              part_name: part.name,
              display_name: part.name,
              status: "active",
              cluster: part.cluster || "nově detekovaný",
              notes: `Auto-mirror ${new Date().toISOString().slice(0, 10)}. Čeká na ověření týmem. ${part.inferred_data || ""}`.slice(0, 500),
              role_in_system: part.sections?.A?.slice(0, 200) || null,
            }, { onConflict: "user_id,part_name", ignoreDuplicates: true });
            state.dbUpdates.push(`registry_new:${part.name}`);

            // ═══ AUTO-TRIGGER VERIFICATION MEETING ═══
            const evidence = part.evidence?.join(", ") || part.sections?.A || "detekováno z konverzací";
            const meetingTopic = `Ověření nové části: ${part.name}`;
            const meetingAgenda = `Karel detekoval potenciální novou část/fragment: "${part.name}".

═══ DŮKAZY ═══
${evidence}

═══ POSTUP OVĚŘENÍ ═══
1. Karel předloží důkazy a kontext detekce
2. Hanka i Káťa se vyjádří, zda se s touto částí setkaly
3. Minimální práh: alespoň 2 ze 3 (Karel + terapeutky) souhlasí
4. Pokud ověřeno → část zůstává v registru a kartotéce
5. Pokud NEověřeno → Karel odstraní kartu a záznam

Karel navrhne specifické ověřovací úkoly pro tento případ.`;

            const karelOpeningMsg = `Ahoj Haničko, ahoj Káťo 👋

Během analýzy konverzací jsem detekoval potenciální novou část/fragment: **${part.name}**.

**Důkazy:**
${evidence}

**Co potřebuji od vás:**
1. Setkaly jste se s touto částí? Pokud ano, popište prosím kontext.
2. Existují další indicie, že jde o samostatnou část (ne alias existující)?
3. Navrhněte prosím pozorování/aktivity, které by potvrdily nebo vyvrátily existenci.

Dokud tým nerozhodne, karta existuje v kartotéce jako "čekající na ověření". Prosím vyjádřete se obě. 🙏`;

            await sb.from("did_meetings").insert({
              user_id: userId,
              topic: meetingTopic,
              agenda: meetingAgenda,
              status: "open",
              triggered_by: "karel_auto_verification",
              messages: [{ role: "karel", content: karelOpeningMsg, timestamp: new Date().toISOString() }],
            });
            state.dbUpdates.push(`meeting_verification:${part.name}`);
          } else {
            state.driveUpdates.push(`KARTOTEKA/NEW:${part.name} (ERR:${writeResult.error})`);
          }
        } catch (e) {
          state.driveUpdates.push(`KARTOTEKA/NEW:${part.name} (ERR:${e instanceof Error ? e.message : "unknown"})`);
        }
      }

      state.newPartIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_new_parts", summary: `Nové části ${state.newPartIndex}/${newParts.length}` });
      return { status: "processing", phase: "drive_new_parts", summary: `Nové části ${state.newPartIndex}/${newParts.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.centrumIndex < centrumWrites.length) {
      const token = await getAccessToken();
      const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]);
      const batch = centrumWrites.slice(state.centrumIndex, state.centrumIndex + MIRROR_BATCH.centrum);

      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          const dateStr = new Date().toISOString().slice(0, 10);
          for (const { pattern, content, label, rewrite } of batch) {
            const doc = await findDoc(token, pattern, centrumId);
            if (!doc) continue;

            if (rewrite) {
              // ═══ FULL REWRITE for Dashboard and Operativni Plan ═══
              const header = label === "Dashboard"
                ? `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel (zrcadlení)\n\n`
                : `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel (zrcadlení)\n\n`;
              await updateDoc(token, doc.id, header + content);
              state.driveUpdates.push(`CENTRUM/${label} (kompletní přepis)`);
              console.log(`[CENTRUM] ✅ Full rewrite via mirror: ${label}`);
            } else {
              // ═══ APPEND for Geography, Relationships ═══
              const hash = contentHash(content);
              const existing = await readDoc(token, doc.id);
              if (!existing.includes(`[KHASH:${hash}]`)) {
                await updateDoc(token, doc.id, `${existing}\n\n[${dateStr}] Zrcadlení: [KHASH:${hash}]\n${content}`);
                state.driveUpdates.push(`CENTRUM/${label}`);
              }
            }
          }
        }
      }

      state.centrumIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_centrum", summary: `Centrum ${state.centrumIndex}/${centrumWrites.length}` });
      return { status: "processing", phase: "drive_centrum", summary: `Centrum ${state.centrumIndex}/${centrumWrites.length}`, progress: getMirrorProgress(payload, state) };
    }

    if (state.clientUpdateIndex < clientUpdates.length) {
      const token = await getAccessToken();
      const zalohaId = await findFolderFuzzy(token, ["ZALOHA", "Zaloha"]);
      const batch = clientUpdates.slice(state.clientUpdateIndex, state.clientUpdateIndex + MIRROR_BATCH.clients);

      if (zalohaId) {
        for (const [clientName, content] of batch) {
          const hash = contentHash(content);
          const clientDoc = await findDoc(token, clientName, zalohaId);
          if (clientDoc) {
            const existing = await readDoc(token, clientDoc.id);
            if (!existing.includes(`[KHASH:${hash}]`)) {
              await updateDoc(token, clientDoc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
              state.driveUpdates.push(`ZALOHA/${clientName}`);
            }
          }
        }
      }

      state.clientUpdateIndex += batch.length;
      await persistMirrorJob({ sb, jobId, payload, state, phase: "drive_clients", summary: `Záloha klientů ${state.clientUpdateIndex}/${clientUpdates.length}` });
      return { status: "processing", phase: "drive_clients", summary: `Záloha klientů ${state.clientUpdateIndex}/${clientUpdates.length}`, progress: getMirrorProgress(payload, state) };
    }

    await finalizeMirrorJob({ sb, jobId, payload, state });
    return { status: "done", phase: "done", summary: extractedInfo?.synthesis_summary || "Zrcadlení dokončeno", progress: getMirrorProgress(payload, state) };
  } catch (bgError) {
    console.error("[mirror-batch] Error:", bgError);
    await sb.from("karel_memory_logs").update({
      log_type: "redistribute",
      summary: `Chyba při zápisu: ${bgError instanceof Error ? bgError.message : "unknown"}`,
      details: {
        error: true,
        phase: "error",
        progress: getMirrorProgress(payload, state),
        dbUpdates: state.dbUpdates,
        driveUpdates: state.driveUpdates,
      },
    }).eq("id", jobId);
    return { status: "error", phase: "error", summary: `Chyba při zápisu: ${bgError instanceof Error ? bgError.message : "unknown"}` };
  }
}

// ── Main ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let reqBody: any = {};
  try { reqBody = await req.json(); } catch {}

  if (reqBody.mode === "status") {
    const jobId = reqBody.jobId;
    if (!jobId) return new Response(JSON.stringify({ error: "jobId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: job } = await sb.from("karel_memory_logs")
      .select("id, user_id, log_type, summary, created_at, details")
      .eq("id", jobId)
      .maybeSingle();

    if (!job) {
      return new Response(JSON.stringify({ status: "idle" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (job.log_type === "mirror_job") {
      return new Response(JSON.stringify({
        status: "processing",
        phase: job.details?.phase || "queued",
        summary: job.summary,
        progress: job.details?.progress || null,
        startedAt: job.created_at,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      status: job.details?.error ? "error" : "done",
      summary: job.summary,
      details: job.details,
      progress: job.details?.progress || null,
      completedAt: job.created_at,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let userId: string;
  if (isCronOrService(req)) {
    if (reqBody.userId) { userId = reqBody.userId; }
    else {
      const { data } = await sb.from("karel_episodes").select("user_id").limit(1);
      userId = data?.[0]?.user_id;
      if (!userId) return new Response(JSON.stringify({ status: "no_users" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } else {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    userId = user.id;
  }

  if (reqBody.mode === "continue") {
    const jobId = reqBody.jobId;
    if (!jobId) return new Response(JSON.stringify({ error: "jobId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: job } = await sb.from("karel_memory_logs")
      .select("id, user_id, log_type, summary, details")
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!job) {
      return new Response(JSON.stringify({ status: "idle" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (job.log_type !== "mirror_job") {
      return new Response(JSON.stringify({
        status: job.details?.error ? "error" : "done",
        phase: job.details?.phase || (job.details?.error ? "error" : "done"),
        summary: job.summary,
        progress: job.details?.progress || null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const currentPhase = job.details?.phase || "created";

    try {
      // ═══ PHASE: HARVEST — collect DB data ═══
      if (currentPhase === "created" || currentPhase === "harvest") {
        console.log(`[mirror] Phase HARVEST for job ${jobId}`);

        const { data: lastMirror } = await sb.from("karel_memory_logs")
          .select("created_at")
          .eq("user_id", userId).eq("log_type", "redistribute")
          .order("created_at", { ascending: false }).limit(1);
        const lastMirrorTime = lastMirror?.[0]?.created_at || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const [hanaRes, didThreadsRes, didConvsRes, researchRes, episodesRes, entitiesRes, patternsRes, relationsRes, strategiesRes, tasksRes, registryRes] = await Promise.all([
          sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain, current_hana_state").eq("user_id", userId).gte("last_activity_at", lastMirrorTime).order("last_activity_at", { ascending: false }).limit(30),
          sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode, part_language").eq("user_id", userId).gte("last_activity_at", lastMirrorTime).order("last_activity_at", { ascending: false }).limit(30),
          sb.from("did_conversations").select("id, label, messages, sub_mode, preview, did_initial_context, saved_at").eq("user_id", userId).gte("saved_at", lastMirrorTime).order("saved_at", { ascending: false }).limit(30),
          sb.from("research_threads").select("id, topic, messages, last_activity_at").eq("user_id", userId).eq("is_deleted", false).gte("last_activity_at", lastMirrorTime).limit(10),
          sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).order("timestamp_start", { ascending: false }).limit(200),
          sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
          sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
          sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
          sb.from("karel_strategies").select("*").eq("user_id", userId),
          sb.from("did_therapist_tasks").select("*").eq("user_id", userId).in("status", ["pending", "in_progress"]),
          sb.from("did_part_registry").select("*").eq("user_id", userId),
        ]);

        const MAX_PER_MSG = 400;
        const MAX_PER_THREAD = 2500;
        const MAX_TOTAL = 18000;

        function buildDigest(msgs: any[]): string {
          if (!Array.isArray(msgs) || msgs.length < 1) return "";
          let total = 0;
          const lines: string[] = [];
          for (const m of msgs) {
            if (total >= MAX_PER_THREAD) break;
            const content = typeof m.content === "string" ? m.content.slice(0, MAX_PER_MSG) : "[media]";
            const line = `${m.role}: ${content}`;
            lines.push(line);
            total += line.length;
          }
          return lines.join("\n");
        }

        const threadDigests: string[] = [];
        let totalChars = 0;
        for (const conv of (hanaRes.data || [])) {
          if (totalChars >= MAX_TOTAL) break;
          const msgs = Array.isArray(conv.messages) ? conv.messages : [];
          if (msgs.length < 1) continue;
          const d = `[HANA|${conv.last_activity_at?.slice(0,16)}|${conv.current_domain}|${conv.current_hana_state}]\n${buildDigest(msgs)}`;
          threadDigests.push(d); totalChars += d.length;
        }
        for (const t of (didThreadsRes.data || [])) {
          if (totalChars >= MAX_TOTAL) break;
          const msgs = Array.isArray(t.messages) ? t.messages : [];
          if (msgs.length < 1) continue;
          const d = `[DID|${t.part_name}|${t.sub_mode}|${t.last_activity_at?.slice(0,16)}]\n${buildDigest(msgs)}`;
          threadDigests.push(d); totalChars += d.length;
        }
        for (const c of (didConvsRes.data || [])) {
          if (totalChars >= MAX_TOTAL) break;
          const msgs = Array.isArray(c.messages) ? c.messages : [];
          if (msgs.length < 1) continue;
          const d = `[DID_KONV|${c.label}|${c.sub_mode}]\n${buildDigest(msgs)}`;
          threadDigests.push(d); totalChars += d.length;
        }
        for (const r of (researchRes.data || [])) {
          if (totalChars >= MAX_TOTAL) break;
          const msgs = Array.isArray(r.messages) ? r.messages : [];
          if (msgs.length < 1) continue;
          const d = `[RESEARCH|${r.topic}]\n${buildDigest(msgs)}`;
          threadDigests.push(d); totalChars += d.length;
        }

        console.log(`[mirror] Harvest: ${threadDigests.length} threads, ${totalChars} chars`);

        if (threadDigests.length === 0) {
          await sb.from("karel_memory_logs").update({
            log_type: "redistribute", summary: "Žádná nová data od posledního zrcadlení.",
            details: { phase: "done", progress: { completed: 1, total: 1, percent: 100 } },
          }).eq("id", jobId);
          return new Response(JSON.stringify({ status: "done", summary: "Žádná nová data od posledního zrcadlení." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const knownPartNames = (registryRes.data || []).map((p: any) => p.part_name || p.display_name);

        await sb.from("karel_memory_logs").update({
          summary: `Harvest: ${threadDigests.length} vláken, ${totalChars} znaků`,
          details: {
            phase: "harvest_done",
            state: createInitialMirrorState(),
            harvest: {
              lastMirrorTime,
              threadDigests,
              totalChars,
              entities: entitiesRes.data || [],
              patterns: patternsRes.data || [],
              relations: relationsRes.data || [],
              strategies: strategiesRes.data || [],
              activeTasks: tasksRes.data || [],
              registry: registryRes.data || [],
              episodes: episodesRes.data || [],
              knownPartNames,
              startTime: Date.now(),
            },
          },
        }).eq("id", jobId);

        return new Response(JSON.stringify({
          status: "processing", phase: "harvest_done",
          summary: `Sběr dat: ${threadDigests.length} vláken. Pokračuji čtením Drive...`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ═══ PHASE: DRIVE READ ═══
      if (currentPhase === "harvest_done" || currentPhase === "drive_read") {
        console.log(`[mirror] Phase DRIVE_READ for job ${jobId}`);
        const harvest = job.details?.harvest;
        if (!harvest) throw new Error("Missing harvest data");

        const driveContents: Record<string, string> = {};
        let driveDocsRead = 0;

        try {
          const token = await getAccessToken();
          const [pametId, kartotekaId, zalohaId] = await Promise.all([
            findFolderFuzzy(token, ["PAMET_KAREL"]),
            findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]),
            findFolderFuzzy(token, ["ZALOHA", "Zaloha"]),
          ]);

          const readFolderDocs = async (folderId: string | null, label: string, limit: number) => {
            if (!folderId) return;
            const allFiles = await listAllFilesRecursive(token, folderId, label);
            const docFiles = allFiles.filter((f) => !f.isFolder).slice(0, limit);
            for (const doc of docFiles) {
              try {
                const content = await readDoc(token, doc.id);
                if (content && content.length > 10) {
                  driveContents[doc.path] = content.slice(0, 1500);
                  driveDocsRead++;
                }
              } catch (e) { console.warn(`[mirror] Could not read ${doc.path}: ${e}`); }
            }
          };

          await readFolderDocs(pametId, "PAMET_KAREL", 6);
          await readFolderDocs(kartotekaId, "KARTOTEKA_DID", 6);
          await readFolderDocs(zalohaId, "ZALOHA", 4);
          console.log(`[mirror] Drive read: ${driveDocsRead} docs`);
        } catch (driveErr) {
          console.error("[mirror] Drive read error (continuing):", driveErr);
        }

        await sb.from("karel_memory_logs").update({
          summary: `Drive: ${driveDocsRead} dokumentů přečteno`,
          updated_at: new Date().toISOString(),
          details: {
            ...job.details,
            phase: "drive_done",
            harvest: { ...harvest, driveContents, driveDocsRead },
          },
        }).eq("id", jobId);

        return new Response(JSON.stringify({
          status: "processing", phase: "drive_done",
          summary: `Drive: ${driveDocsRead} dokumentů. Spouštím AI analýzu...`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ═══ PHASE: AI PASS 1 — extraction ═══
      if (currentPhase === "drive_done" || currentPhase === "ai_pass1") {
        console.log(`[mirror] Phase AI_PASS1 for job ${jobId}`);
        const harvest = job.details?.harvest;
        if (!harvest) throw new Error("Missing harvest data");

        const threadDigests = harvest.threadDigests || [];
        const knownPartNames = harvest.knownPartNames || [];
        const entities = harvest.entities || [];
        const activeTasks = harvest.activeTasks || [];
        const lastMirrorTime = harvest.lastMirrorTime || "";

        const pass1System = `Jsi Karel – DEDUKTIVNÍ ANALYTICKÝ ENGINE. Nejsi sekretářka která zapisuje co vidí. Jsi stratég, který:
1) DEDUKUJE: Z fragmentů informací napříč vlákny vyvozuje závěry. Pokud část X říká že "Káťa nebyla" a Hanka zmíní "Káťa je nemocná" → ZÁVĚR: Káťa je nemocná, ovlivní to plánování úkolů.
2) ANALYZUJE: Hledá PŘÍČINY a DŮSLEDKY, ne jen fakta. Proč se Arthur cítí vyčerpaně? Co to znamená pro terapii?
3) PREDIKUJE: Na základě vzorců odhaduje co se stane. Pokud Tundrup 3x reagoval agresivně na téma školy → PREDIKCE: příští sezení o škole vyvolá odpor.
4) SYNTETIZUJE: Kombinuje informace z 5 různých vláken do jednoho uceleného obrazu situace.
5) PLÁNUJE: Každý poznatek okamžitě převádí na AKCI. Ne "Arthur je smutný" ale "Arthur je smutný → navrhuji Hance techniku X, Káťu upozorním na Y, v příštím sezení doporučuji Z".

KRITICKÉ PRAVIDLO DOMÉN:
- PAMET_KAREL = VÝHRADNĚ profilace TERAPEUTEK (Hanka, Káťa) — osobnostní analýza, motivace, silné/slabé stránky, spolehlivost, emoční vzorce, komunikační preference.
- KARTOTEKA_DID = data o DID ČÁSTECH (Arthur, Tundrup atd.) — klinické záznamy, triggery, emoce, sezení.
- NIKDY nevkládej data o DID částech do PAMET_KAREL.
- Karel tajně buduje dynamický profil každé terapeutky pro personalizaci vedení.

DEDUKČNÍ ŘETĚZCE:
Při analýze hledej ŘETĚZCE SOUVISLOSTÍ: fakt A (vlákno 1) + fakt B (vlákno 2) → závěr C → akce D → dopad E.
Každý závěr musí mít zdůvodnění a navrhovanou akci.`;

        const pass1Prompt = `REGISTR ČÁSTÍ: ${knownPartNames.join(", ") || "prázdný"}
ENTITY: ${entities.map((e: any) => `${e.id}:${e.jmeno}`).join(", ") || "žádné"}
ÚKOLY: ${activeTasks.map((t: any) => `[${t.assigned_to}] ${t.task}`).join("; ") || "žádné"}

═══ VLÁKNA (od ${lastMirrorTime.slice(0, 16)}) ═══
${threadDigests.join("\n═══\n")}

DŮLEŽITÉ — CITOVÉ VAZBY A COUNTERTRANSFERENCE:
Když terapeutka (Hanka/Káťa) popisuje svůj VZTAH k části (např. "je to moje deťátko", "cítím k němu nostalgii", "rozumí si s Káťou"), toto je KLÍČOVÁ informace pro DVĚ domény:
1) THERAPIST profil: Jak terapeutka citově prožívá části → její countertransference vzorce, citové vazby, postoje (do part_emotional_bonds)
2) DID_PART karta: Terapeutčino pozorování jako klinický záznam (do raw_facts s domain=DID_PART)
NIKDY tyto informace nevypisuj doslovně v přehledu! Extrahuj je jako ANALYTICKÉ ZÁVĚRY.

Vrať JSON: {"raw_facts":[{"subject":"...","fact":"...","confidence":0.9,"domain":"THERAPIST|DID_PART|GENERAL"}],"all_names_mentioned":["..."],"new_parts_detected":[{"name":"...","evidence":"...","confidence":0.9}],"therapist_profiles":{"hanka":{"mood":"...","stress_level":"...","energy":"...","life_situation_notes":"...","reliability_observations":"...","communication_preferences":"...","personality_traits":["..."],"strengths_observed":["..."],"weaknesses_observed":["..."],"current_challenges":["..."],"notable_behaviors":["..."],"part_emotional_bonds":[{"part_name":"TUNDRUPEK","bond_type":"mateřský/ochranitelský/nostalgický/partnerský/jiný","description":"Karel dedukuje: silný mateřský countertransference, potřeba monitorovat hranice","therapeutic_implication":"co to znamená pro terapii"}]},"kata":{"mood":"...","stress_level":"...","energy":"...","life_situation_notes":"...","reliability_observations":"...","communication_preferences":"...","personality_traits":["..."],"strengths_observed":["..."],"weaknesses_observed":["..."],"current_challenges":["..."],"notable_behaviors":["..."],"part_emotional_bonds":[{"part_name":"...","bond_type":"...","description":"...","therapeutic_implication":"..."}]}},"urgent_signals":["..."],"cross_thread_deductions":[{"deduction":"ZÁVĚR vyvozený z kombinace vláken","sources":["thread1","thread2"],"reasoning":"PROČ tento závěr vyplývá z faktů","actionable":true,"recommended_action":"CO s tím Karel/terapeut má UDĚLAT","predicted_impact":"CO se stane pokud se to neřeší / řeší"}],"causal_chains":[{"trigger":"co se stalo","cause":"proč","effect":"jaký dopad","prediction":"co bude dál","action_plan":"co s tím"}],"summary":"..."}`;

        const pass1Raw = await callAI(LOVABLE_API_KEY!, pass1System, pass1Prompt, "google/gemini-2.5-flash");
        const pass1Data = extractJSON(pass1Raw) || { raw_facts: [], all_names_mentioned: [], new_parts_detected: [], therapist_observations: {}, urgent_signals: [] };

        console.log(`[mirror] Pass1: ${pass1Data.raw_facts?.length || 0} facts, ${pass1Data.all_names_mentioned?.length || 0} names`);

        await sb.from("karel_memory_logs").update({
          summary: `AI Pass 1: ${pass1Data.raw_facts?.length || 0} faktů, ${pass1Data.all_names_mentioned?.length || 0} jmen`,
          updated_at: new Date().toISOString(),
          details: {
            ...job.details,
            phase: "pass1_done",
            harvest: { ...harvest, pass1Data },
          },
        }).eq("id", jobId);

        return new Response(JSON.stringify({
          status: "processing", phase: "pass1_done",
          summary: `Extrakce: ${pass1Data.raw_facts?.length || 0} faktů. Spouštím syntézu...`,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ═══ PHASE: AI PASS 2 — synthesis ═══
      if (currentPhase === "pass1_done" || currentPhase === "ai_pass2") {
        console.log(`[mirror] Phase AI_PASS2 for job ${jobId}`);
        const harvest = job.details?.harvest;
        if (!harvest) throw new Error("Missing harvest data");

        const pass1Data = harvest.pass1Data || {};
        const registry = harvest.registry || [];
        const entities = harvest.entities || [];
        const patterns = harvest.patterns || [];
        const driveContents = harvest.driveContents || {};
        const driveDocsRead = harvest.driveDocsRead || 0;

        const driveDigest = Object.entries(driveContents)
          .map(([path, content]) => `[DRIVE:${path}]\n${(content as string).slice(0, 1000)}`)
          .join("\n═══\n");

        const pass2System = `Jsi Karel – STRATEGICKÝ OPERAČNÍ VELITEL DID systému. Nejsi pasivní zapisovatel. Jsi aktivní analytik který:

MYŠLENKOVÝ POSTUP PŘI KAŽDÉM ZÁPISU:
1. FAKTA → Co přesně vím? (citace ze zdrojů)
2. DEDUKCE → Co z toho VYPLÝVÁ? (logické závěry)
3. PREDIKCE → Co se STANE pokud nezasáhneme? Co se stane pokud zasáhneme?
4. AKČNÍ PLÁN → CO PŘESNĚ má KDO UDĚLAT a DOKDY?
5. KONTROLNÍ MECHANISMUS → Jak ověřím že se to stalo?

NIKDY NEPIŠ do 00_CENTRUM pouhé shrnutí! VŽDY piš INSTRUKCE, DOPORUČENÍ, VAROVÁNÍ, PLÁNY.

Špatný příklad: "Arthur byl smutný a mluvil o samotě."
Správný příklad: "Arthur vykazuje narůstající izolaci (3 vlákna za 5 dní). PŘÍČINA: pravděpodobně reakce na Káťinu nepřítomnost. PREDIKCE: bez zásahu hrozí regrese. AKCE: Hanka má v příštím sezení použít techniku 'bezpečné místo', Káťa zapíše Arthurovi vzkaz přes deník. DEADLINE: 2 dny. KONTROLA: Karel ověří v dalším vlákně s Arthurem."

KRITICKÉ PRAVIDLO DOMÉN:
- pamet_karel = VÝHRADNĚ profilace TERAPEUTEK (Hanka, Káťa). Vzorce chování, motivace, silné/slabé stránky, komunikační strategie.
- kartoteka_did = DID ČÁSTI (Arthur, Tundrup atd.). Klinické záznamy, triggery, emoce.
- NIKDY nevkládej DID části do pamet_karel.

ANALYTICKÉ INSTRUKCE:
- Každý zápis do Dashboard MUSÍ obsahovat: CO → PROČ → AKCE → KDO → DOKDY
- Každý zápis do Operativního plánu MUSÍ obsahovat měřitelné cíle a kontrolní body
- Každý zápis do karet částí MUSÍ obsahovat terapeutický dopad a doporučení
- Karel KOMBINUJE informace napříč vlákny a na jejich základě VYVOZUJE závěry a PIŠ INSTRUKCE které povedou k AKTIVNÍMU ŘEŠENÍ`;

        const registryDigest = registry.map((p: any) => {
          const lastSeen = p.last_seen_at ? new Date(p.last_seen_at).toISOString().slice(0, 10) : "?";
          return `${p.part_name}(${p.status}, cluster:${p.cluster||"?"}, last:${lastSeen})`;
        }).join(", ");
        const activeTasksDigest = (harvest.activeTasks || []).map((t: any) => {
          const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
          return `[${t.assigned_to}|${t.priority||"normal"}|${age}d] ${t.task}`;
        }).join("; ");

        const pass2Prompt = `═══ FAKTA ═══
${JSON.stringify(pass1Data, null, 1).slice(0, 8000)}

═══ REGISTRY ČÁSTÍ ═══
${registryDigest}

═══ AKTIVNÍ ÚKOLY TERAPEUTŮ ═══
${activeTasksDigest || "žádné"}

═══ ENTITY ═══
${entities.map((e: any) => `${e.jmeno}(${e.typ})`).join(", ")}

═══ DRIVE (${driveDocsRead}) ═══
${driveDigest.slice(0, 12000)}

Vrať JSON:
{"pamet_karel":{"entity_updates":[{"id":"...","jmeno":"...","typ":"clovek","role_vuci_hance":"...","new_properties":["..."],"new_notes":"..."}],"pattern_updates":[{"id":"TERAPEUT_vzorec_id","description":"vzorec chování TERAPEUTKY","domain":"THERAPIST","tags":["hanka|kata","osobnost|motivace|styl"],"confidence_delta":0.1}],"relation_updates":[{"subject_id":"...","relation":"...","object_id":"...","description":"..."}],"strategy_updates":[{"id":"TERAPEUT_strategie_id","description":"strategie komunikace Karla s TERAPEUTKOU","domain":"THERAPIST","hana_state":"...","effectiveness_delta":0.1,"new_guidelines":["..."]}],"therapist_situational_profile":{"hanka":{"current_mood":"...","energy_level":"...","life_challenges":["..."],"recent_behaviors":["..."],"recommended_approach":"...","personality_traits":["..."],"strengths_observed":["..."],"weaknesses_observed":["..."],"current_challenges":["..."],"notable_behaviors":["..."],"part_emotional_bonds":[{"part_name":"JMÉNO_ČÁSTI","bond_type":"mateřský/ochranitelský/nostalgický/partnerský/empatický/jiný","description":"Karlova dedukce: co citová vazba odhaluje o terapeutce (countertransference vzorec)","therapeutic_implication":"jak to ovlivní terapii, co Karel doporučuje"}]},"kata":{"current_mood":"...","energy_level":"...","life_challenges":["..."],"recent_behaviors":["..."],"recommended_approach":"...","personality_traits":["..."],"strengths_observed":["..."],"weaknesses_observed":["..."],"current_challenges":["..."],"notable_behaviors":["..."],"part_emotional_bonds":[{"part_name":"...","bond_type":"...","description":"...","therapeutic_implication":"..."}]}}},"kartoteka_did":{"part_updates":{"name":"text pro kartu části — ZAHRŇ pozorování terapeutky jako klinický záznam (co terapeutka řekla O části, její popis chování části, nikoli surové citáty ale analytické shrnutí)"},"new_parts":[{"name":"...","sections":{"A":"..."},"status":"active","cluster":"nově detekovaný","confidence":0.9,"evidence":["..."]}]},"zaloha":{"client_updates":{"name":"notes"}},"new_tasks":[{"task":"...","assigned_to":"...","priority":"...","category":"...","reasoning":"..."}],"centrum_updates":{"dashboard_full":"KOMPLETNÍ 7-sekční Dashboard (viz instrukce níže)","operative_plan_full":"KOMPLETNÍ 6-sekční Operativní plán (viz instrukce níže)","geography_notes":"...","relationships_notes":"..."},"synthesis_summary":"..."}

═══ INSTRUKCE PRO CENTRUM DOKUMENTY ═══

dashboard_full: Vygeneruj KOMPLETNÍ nový Dashboard (PŘEPISUJE SE CELÝ). Dashboard NENÍ pasivní shrnutí. Je to OPERAČNÍ CENTRUM — terapeut ho otevře a VÍ co má dělat TEĎKA.
SEKCE 1 – STAV SYSTÉMU + KARLOVA ANALÝZA: Pro KAŽDOU aktivní část: jméno, stav 🟢🟡🔴, nálada, poslední kontakt, KARLŮV ZÁVĚR (co z toho vyplývá, jaký je trend, predikce kam to směřuje).
SEKCE 2 – KRITICKÁ UPOZORNĚNÍ + AKČNÍ PLÁN ⚠️: Ne jen "úkol X nesplněn" ale "úkol X nesplněn 4 dny → PŘÍČINA: Káťa pravděpodobně zahlcena školou → AKCE: Karel přeřadí úkol na Hanku / sníží náročnost → KONTROLA: zítra ověřit". Pokud žádná: "✅ Systém stabilní, žádné eskalace"
SEKCE 3 – DEDUKCE Z POSLEDNÍCH DNŮ 🧠: NENÍ shrnutí "kdo mluvil". Je to ANALÝZA: Co Karel vyvodil z kombinace vláken? Jaké skryté souvislosti objevil? Jaké vzorce se opakují? Co se mění k lepšímu/horšímu a PROČ?
SEKCE 4 – TERAPEUTICKÉ INSTRUKCE 🎯: KONKRÉTNÍ příkazy pro každou terapeutku: "Hanka: v příštím sezení s Arthurem použij techniku X, protože Y. Káťa: Tundrupek potřebuje Z, protože analýza vláken ukazuje W." S odůvodněním PROČ a s měřitelným cílem.
SEKCE 5 – PREDIKCE A PREVENCE 🔮: Co Karel PŘEDPOVÍDÁ na základě vzorců? Jaké rizikové scénáře hrozí? Jaké preventivní kroky doporučuje? "Pokud Arthur nebude kontaktován do 3 dnů, predikuji regresi na základě vzorce z minulého měsíce."
SEKCE 6 – KOORDINAČNÍ INSTRUKCE 💬: Ne jen "most mezi terapeuty". Ale: "Hanka zjistila X. To ovlivní Káťinu práci s Y. Karel doporučuje: Káťa změní přístup Z. Hanka ať doplní informaci W." + připomínky nesplněných úkolů s DŮVODEM proč je důležité je splnit.
SEKCE 7 – KARLOVY STRATEGICKÉ POSTŘEHY 🔍: Hloubkové hypotézy, kauzální řetězce, co funguje a co ne a PROČ, doporučení změn strategie, evaluace vlastní efektivity.

operative_plan_full: Vygeneruj KOMPLETNÍ nový Operativní plán (PŘEPISUJE SE CELÝ). Plán NENÍ seznam, je to STRATEGICKÝ DOKUMENT s ODŮVODNĚNÍM:
SEKCE 1 – STAV ČÁSTÍ + TRENDY: Každá aktivní část: stav, TREND (↑↗→↘↓), ANALÝZA proč trend takový je, CO s tím.
SEKCE 2 – PLÁN SEZENÍ S ODŮVODNĚNÍM: "S Arthurem pracovat metodou X PROTOŽE analýza ukazuje Y, CÍL: dosáhnout Z, MĚŘÍTKO ÚSPĚCHU: W."
SEKCE 3 – ÚKOLY + ACCOUNTABILITY: ☐/☑ + u každého nesplněného: PROČ není splněn (Karlova dedukce), CO s tím, ESKALACE pokud deadline překročen.
SEKCE 4 – KOORDINACE S DEDUKCÍ: "Hanka ví X z vlákna A. Káťa ví Y z vlákna B. ZÁVĚR: Z. AKCE: Karel doporučuje společné sezení / výměnu informací o W."
SEKCE 5 – RIZIKA + PREVENCE + PREDIKCE: Ne jen seznam rizik, ale KAUZÁLNÍ ANALÝZA: "Riziko A vzniká PROTOŽE B, predikce: pokud C pak D, PREVENCE: E."
SEKCE 6 – KARLOVA STRATEGICKÁ REFLEXE: Evaluace vlastního vedení, co funguje, co změnit, jaké chyby Karel udělal, co se naučil.

geography_notes a relationships_notes: pouze NOVÉ poznatky (appendují se) — i zde ANALYTICKY: ne jen "Arthur žije v X" ale "Arthur se přesunul do X, PŘÍČINA: pravděpodobně Y, DOPAD na terapii: Z".`;

        const pass2Raw = await callAI(LOVABLE_API_KEY!, pass2System, pass2Prompt, "google/gemini-2.5-flash");
        const extractedInfo = extractJSON(pass2Raw) || { pamet_karel: {}, kartoteka_did: {}, new_tasks: [] };

        console.log(`[mirror] Pass2: ${(extractedInfo.kartoteka_did?.new_parts || []).length} new parts, ${(extractedInfo.new_tasks || []).length} tasks`);

        // Build final payload for batch writes
        const payload = {
          startTime: harvest.startTime || Date.now(),
          lastMirrorTime: harvest.lastMirrorTime,
          threadCount: (harvest.threadDigests || []).length,
          driveDocsRead: harvest.driveDocsRead || 0,
          pass1Data: harvest.pass1Data,
          extractedInfo,
          entities: harvest.entities || [],
          patterns: harvest.patterns || [],
          relations: harvest.relations || [],
          strategies: harvest.strategies || [],
          activeTasks: harvest.activeTasks || [],
          registry: harvest.registry || [],
          episodes: harvest.episodes || [],
        };

        await sb.from("karel_memory_logs").update({
          summary: `Syntéza hotová. ${(extractedInfo.new_tasks || []).length} úkolů, ${(extractedInfo.kartoteka_did?.new_parts || []).length} nových částí.`,
          updated_at: new Date().toISOString(),
          details: {
            phase: "queued",
            payload,
            state: createInitialMirrorState(),
            progress: getMirrorProgress(payload, createInitialMirrorState()),
          },
        }).eq("id", jobId);

        return new Response(JSON.stringify({
          status: "processing", phase: "queued",
          summary: `Syntéza hotová. Zahajuji dávkové zápisy...`,
          progress: getMirrorProgress(payload, createInitialMirrorState()),
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ═══ BATCH WRITE PHASES (existing logic) ═══
      const payload = job.details?.payload;
      if (!payload) {
        await sb.from("karel_memory_logs").update({
          log_type: "mirror_failed",
          summary: "Chyba: chybí payload jobu",
          updated_at: new Date().toISOString(),
          details: { error: true, phase: "error" },
        }).eq("id", jobId);
        return new Response(JSON.stringify({ status: "error", phase: "error", summary: "Chyba: chybí payload" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const result = await runMirrorBatchStep({
        sb,
        userId,
        jobId,
        payload,
        state: job.details?.state,
      });

      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (continueError) {
      console.error("[mirror] Continue error:", continueError);
      await sb.from("karel_memory_logs").update({
        log_type: "mirror_failed",
        summary: `Chyba: ${continueError instanceof Error ? continueError.message : "unknown"}`,
        updated_at: new Date().toISOString(),
        details: { error: true, phase: "error" },
      }).eq("id", jobId);
      return new Response(JSON.stringify({ status: "error", phase: "error", summary: continueError instanceof Error ? continueError.message : "Neznámá chyba" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  try {
    // ═══ HEARTBEAT-BASED CONCURRENCY LOCK ═══
    const HEARTBEAT_STALE_MINUTES = 3;
    const force = body?.force === true;
    const heartbeatCutoff = new Date(Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000).toISOString();

    // Force mode: kill all existing mirror_job rows for this user
    if (force) {
      console.log("[mirror] Force mode: cleaning up old jobs");
      await sb.from("karel_memory_logs")
        .update({ log_type: "mirror_failed", summary: "Ukončeno force modem", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("log_type", "mirror_job");
    } else {
      // Check for alive jobs (updated_at within last 3 minutes)
      const { data: aliveJobs } = await sb.from("karel_memory_logs")
        .select("id, updated_at")
        .eq("user_id", userId)
        .eq("log_type", "mirror_job")
        .gte("updated_at", heartbeatCutoff);

      if (aliveJobs && aliveJobs.length > 0) {
        return new Response(JSON.stringify({ status: "skipped", reason: "Redistribuce již probíhá." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Auto-cleanup stale jobs (heartbeat older than 3 min)
      await sb.from("karel_memory_logs")
        .update({ log_type: "mirror_failed", summary: "Automaticky ukončeno (stale heartbeat)", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("log_type", "mirror_job")
        .lt("updated_at", heartbeatCutoff);
    }

    const { data: lockRow, error: insertError } = await sb.from("karel_memory_logs").insert({
      user_id: userId, log_type: "mirror_job", summary: "Job vytvořen, čekám na fázi harvest...",
      details: { phase: "created", state: createInitialMirrorState() },
    }).select("id, created_at").single();

    if (insertError) {
      console.error("[mirror] Insert error:", insertError);
      return new Response(JSON.stringify({ error: `Insert failed: ${insertError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const jobId = lockRow!.id;
    console.log("[mirror] Job created:", jobId, "for user:", userId, force ? "(force)" : "");

    // Return immediately – all heavy work happens in "continue" calls
    return new Response(JSON.stringify({
      status: "processing",
      jobId,
      phase: "created",
      summary: "Job vytvořen. Spouštím sběr dat...",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[mirror] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Formatters ──
function formatEntities(entities: any[]): string {
  const lines = ["SÉMANTICKÉ ENTITY KARLA", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${entities.length}`, ""];
  for (const e of entities) {
    lines.push(`${e.jmeno} (${e.typ})`);
    lines.push(`Role vůči Hance: ${e.role_vuci_hance || "–"}`);
    if (e.stabilni_vlastnosti?.length) lines.push(`Vlastnosti: ${e.stabilni_vlastnosti.join(", ")}`);
    if (e.notes) lines.push(`Poznámky: ${e.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatPatterns(patterns: any[]): string {
  const lines = ["VZORCE CHOVÁNÍ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${patterns.length}`, ""];
  for (const p of patterns) {
    lines.push(`${p.id}`);
    lines.push(`Popis: ${p.description}`);
    lines.push(`Doména: ${p.domain} | Confidence: ${p.confidence}`);
    if (p.tags?.length) lines.push(`Tagy: ${p.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatRelations(relations: any[]): string {
  const lines = ["SÉMANTICKÉ VZTAHY", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${relations.length}`, ""];
  for (const r of relations) {
    lines.push(`${r.subject_id} → [${r.relation}] → ${r.object_id} (confidence: ${r.confidence})`);
    if (r.description) lines.push(`  Popis: ${r.description}`);
  }
  return lines.join("\n");
}

function formatStrategies(strategies: any[]): string {
  const lines = ["STRATEGIE INTERAKCE", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${strategies.length}`, ""];
  for (const s of strategies) {
    lines.push(`${s.id}`);
    lines.push(`Popis: ${s.description}`);
    lines.push(`Doména: ${s.domain} | Stav: ${s.hana_state} | Efektivita: ${s.effectiveness_score}`);
    if (s.guidelines?.length) for (const g of s.guidelines) lines.push(`  - ${g}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatEpisodes(episodes: any[]): string {
  const lines = ["EPIZODICKÁ PAMĚŤ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${episodes.length}`, ""];
  for (const ep of episodes) {
    lines.push(`[${ep.timestamp_start}] ${ep.summary_karel}`);
    lines.push(`Doména: ${ep.domain} | Stav: ${ep.hana_state} | Intenzita: ${ep.emotional_intensity}`);
    if (ep.tags?.length) lines.push(`Tagy: ${ep.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
