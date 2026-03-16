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
    partUpdateIndex: 0,
    newPartIndex: 0,
    centrumIndex: 0,
    clientUpdateIndex: 0,
    dbUpdates: [],
    driveUpdates: [],
  };
}

function buildCentrumWrites(extractedInfo: any): Array<{ pattern: string; content: string; label: string }> {
  const cu = extractedInfo?.centrum_updates;
  if (!cu) return [];

  const writes: Array<{ pattern: string; content: string; label: string }> = [];
  if (cu.dashboard_notes) writes.push({ pattern: "Dashboard", content: cu.dashboard_notes, label: "Dashboard" });
  if (cu.geography_notes) writes.push({ pattern: "Geografie", content: cu.geography_notes, label: "Geografie" });
  if (cu.relationships_notes) writes.push({ pattern: "Vztah", content: cu.relationships_notes, label: "Mapa_Vztahu" });
  if (cu.operative_plan_notes) writes.push({ pattern: "Operativn", content: cu.operative_plan_notes, label: "Operativni_Plan" });
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
    log_type: "redistribute",
    summary: synthesisSum,
    details: {
      totalMs: totalTime,
      scope: lastMirrorTime,
      phase: "done",
      progress: getMirrorProgress(payload, {
        ...state,
        semanticDriveDone: true,
        proceduralDriveDone: true,
        episodesDriveDone: true,
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
      for (const task of batch) {
        if (!task.task) continue;
        const existingTask = activeTasks.find((t: any) => t.task.toLowerCase().includes(task.task.toLowerCase().slice(0, 30)));
        if (existingTask) {
          state.dbUpdates.push(`task_dedup:${task.task.slice(0, 40)}`);
          continue;
        }
        await sb.from("did_therapist_tasks").insert({
          user_id: userId,
          task: task.task,
          assigned_to: task.assigned_to || "both",
          priority: task.priority || "normal",
          category: task.category || "general",
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
          const writeRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-drive-write`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
            body: JSON.stringify({ mode: "update-card-sections", partName: part.name, sections: part.sections }),
          });
          const writeResult = await writeRes.json();
          if (writeRes.ok && writeResult.success) {
            state.driveUpdates.push(`KARTOTEKA/NEW:${part.name}`);
            await sb.from("did_part_registry").upsert({
              user_id: userId,
              part_name: part.name,
              display_name: part.name,
              status: part.status === "Aktivní" ? "active" : "sleeping",
              cluster: part.cluster || null,
              notes: `Auto-mirror ${new Date().toISOString().slice(0, 10)}. ${part.inferred_data || ""}`.slice(0, 500),
              role_in_system: part.sections?.A?.slice(0, 200) || null,
            }, { onConflict: "user_id,part_name", ignoreDuplicates: true });
            state.dbUpdates.push(`registry_new:${part.name}`);
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
          for (const { pattern, content, label } of batch) {
            const hash = contentHash(content);
            const doc = await findDoc(token, pattern, centrumId);
            if (doc) {
              const existing = await readDoc(token, doc.id);
              if (!existing.includes(`[KHASH:${hash}]`)) {
                await updateDoc(token, doc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
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

    const payload = job.details?.payload;
    if (!payload) {
      await sb.from("karel_memory_logs").update({
        log_type: "redistribute",
        summary: "Chyba při zápisu: chybí payload jobu",
        details: { error: true, phase: "error" },
      }).eq("id", jobId);
      return new Response(JSON.stringify({ status: "error", phase: "error", summary: "Chyba při zápisu: chybí payload jobu" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result = await runMirrorBatchStep({
      sb,
      userId,
      jobId,
      payload,
      state: job.details?.state,
    });

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    // ═══ CONCURRENCY LOCK ═══
    const LOCK_MINUTES = 5;
    const { data: lockRow } = await sb.from("karel_memory_logs").insert({
      user_id: userId, log_type: "mirror_job", summary: "Job vytvořen, čekám na fázi harvest...",
      details: { phase: "created", state: createInitialMirrorState() },
    }).select("id, created_at").single();
    const jobId = lockRow?.id;

    const lockCutoff = new Date(Date.now() - LOCK_MINUTES * 60 * 1000).toISOString();
    const { data: allLocks } = await sb.from("karel_memory_logs")
      .select("id, created_at")
      .eq("user_id", userId).eq("log_type", "mirror_job")
      .gte("created_at", lockCutoff).order("created_at", { ascending: true });

    const olderLock = allLocks?.find((l: any) => l.id !== jobId && l.created_at <= (lockRow?.created_at || ""));
    if (olderLock) {
      if (jobId) await sb.from("karel_memory_logs").delete().eq("id", jobId);
      return new Response(JSON.stringify({ status: "skipped", reason: "Redistribuce již probíhá." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log("[mirror] Job created:", jobId, "for user:", userId);

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
