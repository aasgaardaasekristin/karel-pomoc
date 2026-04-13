import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { loadEntityRegistry } from "../_shared/entityRegistry.ts";
import { resolveEntity } from "../_shared/entityResolution.ts";

/**
 * karel-did-auto-session-plan
 * 
 * Automatic daily session plan generator (triggered at 5:00 UTC / ~6:00 CET by cron).
 * 
 * 1. Calculates URGENCY SCORE for each part in registry
 * 2. STRICTLY filters out sleeping/dormant parts from auto-selection
 * 3. Reads part card + 00_CENTRUM documents from Drive
 * 4. Perplexity research based on diagnosis/needs
 * 5. Generates 60min session plan via AI with VEDE: Hanka/Káťa
 * 6. Stores in did_daily_session_plans (queue — INSERT, never DELETE old)
 * 7. Writes to Drive (05_PLAN/05_Operativni_Plan)
 * 8. Creates operative task in did_therapist_tasks
 */

// ═══ OAuth2 + Drive helpers ═══
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth creds");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readFileContent(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isGoogleSheet = mimeType === "application/vnd.google-apps.spreadsheet";
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  const isGoogleWorkspace = mimeType?.startsWith("application/vnd.google-apps.");

  if (isGoogleSheet) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot export sheet ${fileId}`);
    return await exportRes.text();
  }

  if (isGoogleDoc || isGoogleWorkspace) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot export doc ${fileId}`);
    return await exportRes.text();
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return await exportRes.text();
  }
  return await res.text();
}

async function appendToGoogleDoc(token: string, fileId: string, text: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!docRes.ok) throw new Error(`Cannot read doc ${fileId}`);
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

  await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: endIndex - 1 }, text: `\n\n${text}` } }],
    }),
  });
}

const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;
const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function getPragueDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

// ═══ Urgency scoring v2 ═══
interface UrgencyResult {
  partName: string;
  score: number;
  breakdown: Record<string, number>;
  tier: "fading" | "active" | "sleeping" | "override";
}

function calculateUrgencyScores(
  registry: any[],
  threads3d: any[],
  threads24h: any[],
  crisisBriefs24h: any[],
  pendingTasks: any[],
  sessions: any[],
): UrgencyResult[] {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const crisisPartNames = new Set<string>();
  for (const brief of crisisBriefs24h) {
    for (const part of registry) {
      if (brief.scenario?.toLowerCase().includes(part.part_name.toLowerCase()) ||
          brief.raw_brief?.toLowerCase().includes(part.part_name.toLowerCase())) {
        crisisPartNames.add(part.part_name);
      }
    }
  }

  const activeParts3d = new Set<string>();
  for (const t of threads3d) {
    if (t.sub_mode === "cast") activeParts3d.add(t.part_name);
  }

  const activeParts24h = new Set<string>();
  for (const t of threads24h) {
    if (t.sub_mode === "cast") activeParts24h.add(t.part_name);
  }

  const tasksByPart = new Map<string, number>();
  for (const t of pendingTasks) {
    const cat = t.category || "";
    for (const part of registry) {
      if (t.task?.toLowerCase().includes(part.part_name.toLowerCase()) || cat.toLowerCase().includes(part.part_name.toLowerCase())) {
        tasksByPart.set(part.part_name, (tasksByPart.get(part.part_name) || 0) + 1);
      }
    }
  }

  return registry.map(part => {
    const breakdown: Record<string, number> = {};
    let score = 0;

    const wasActive3d = activeParts3d.has(part.part_name);
    const isActive24h = activeParts24h.has(part.part_name);

    let tier: "fading" | "active" | "sleeping";
    if (wasActive3d && !isActive24h) {
      tier = "fading";
      breakdown["fading_alert"] = 6;
      score += 6;
    } else if (wasActive3d) {
      tier = "active";
      breakdown["active_3d"] = 4;
      score += 4;
    } else {
      tier = "sleeping";
      const lastSeen = part.last_seen_at ? new Date(part.last_seen_at).getTime() : 0;
      const daysSinceLastSeen = lastSeen ? (now - lastSeen) / DAY : Infinity;
      if (daysSinceLastSeen > 7) {
        breakdown["dormant_7d"] = 1;
        score += 1;
      }
    }

    if (crisisPartNames.has(part.part_name)) {
      breakdown["crisis"] = 5;
      score += 5;
    }

    const triggers = (part.known_triggers || []).map((t: string) => t.toLowerCase());
    const hasNightmares = triggers.some((t: string) => t.includes("noční") || t.includes("flashback") || t.includes("nightmare"));
    const emoState = (part.last_emotional_state || "").toLowerCase();
    if (hasNightmares || emoState.includes("flashback") || emoState.includes("nocni")) {
      breakdown["nightmares_flashbacks"] = 4;
      score += 4;
    }

    if ((part.last_emotional_intensity || 0) >= 4) {
      breakdown["emotional_dysregulation"] = 3;
      score += 3;
    }

    if ((tasksByPart.get(part.part_name) || 0) > 0) {
      breakdown["pending_tasks"] = 2;
      score += 2;
    }

    return { partName: part.part_name, score, breakdown, tier };
  }).sort((a, b) => {
    const tierOrder = { fading: 0, active: 1, sleeping: 2, override: -1 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.score - a.score;
  });
}

// ═══ Perplexity research ═══
async function searchPerplexity(query: string): Promise<string> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "Jsi odborný asistent pro terapii DID. Odpovídej česky, stručně a prakticky." },
          { role: "user", content: query },
        ],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const data = await res.json();
    return truncate(data.choices?.[0]?.message?.content || "", 2000);
  } catch {
    return "";
  }
}

// ═══ Read 00_CENTRUM key documents ═══
async function readCentrumDocuments(token: string, centrumFolderId: string): Promise<string> {
  const centrumFiles = await listFilesInFolder(token, centrumFolderId);
  const keyDocs = ["00_Aktualni_Dashboard", "01_Index_Vsech_Casti", "02_Instrukce", "04_Mapa_Vztahu"];
  const results: string[] = [];

  for (const docKey of keyDocs) {
    const file = centrumFiles.find(f =>
      canonicalText(f.name).includes(canonicalText(docKey)) &&
      f.mimeType !== "application/vnd.google-apps.folder"
    );
    if (file) {
      try {
        const content = await readFileContent(token, file.id, file.mimeType);
        results.push(`### ${file.name}\n${truncate(content, 1500)}`);
      } catch (e) {
        console.warn(`[auto-session-plan] Failed to read ${file.name}:`, e);
      }
    }
  }

  return results.join("\n\n");
}

// ═══ Parse session_lead from AI response ═══
function parseSessionLead(markdown: string): { lead: string; format: string } {
  // Look for VEDE: HANKA + KÁŤA / OBĚ / HANKA / KÁŤA patterns
  const vedeMatch = markdown.match(/VEDE:\s*(HANKA\s*\+\s*KÁŤA|HANKA\s*\+\s*KATA|OBĚ|OBE|HANKA|KÁŤA|KATA|Hanka\s*\+\s*Káťa|Hanka\s*\+\s*Kata|Hanka|Káťa|Kata)/i);
  if (!vedeMatch) return { lead: "hanka", format: "osobně" };

  const raw = vedeMatch[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Check for combined lead
  if (raw.includes("+") || raw === "obe") {
    return { lead: "obe", format: "kombinované" };
  }
  if (raw === "kata" || raw === "katka") {
    const formatMatch = markdown.match(/VEDE:\s*(?:KÁŤA|KATA|Káťa|Kata)\s*\(([^)]+)\)/i);
    const format = formatMatch?.[1]?.toLowerCase().trim() || "chat";
    return { lead: "kata", format };
  }
  return { lead: "hanka", format: "osobně" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const isCron = req.headers.get("user-agent")?.includes("pg_net") ||
    authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY") || "___none___");

  // ═══ TIMEZONE GUARD — ensure cron runs only in 5:00–7:00 Prague time ═══
  if (isCron) {
    const pragueHour = parseInt(
      new Date().toLocaleString("en", {
        timeZone: "Europe/Prague",
        hour: "numeric",
        hour12: false,
      })
    );
    if (pragueHour < 5 || pragueHour > 7) {
      console.log(`[auto-session-plan] Timezone guard: pragueHour=${pragueHour}, skipping.`);
      return new Response(JSON.stringify({ skipped: true, reason: "outside_window", pragueHour }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const todayPrague = getPragueDate();

  let userId: string | null = null;
  if (!isCron) {
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await sb.auth.getUser(token);
    userId = user?.id || null;
  }
  if (!userId) {
    const { data: firstPart } = await sb.from("did_part_registry").select("user_id").limit(1).maybeSingle();
    userId = firstPart?.user_id || null;
  }
  if (!userId) {
    return new Response(JSON.stringify({ error: "No user_id found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    let forcePart: string | null = null;
    let therapistContext: string | null = null;
    try {
      const body = await req.json();
      forcePart = body?.forcePart || null;
      therapistContext = body?.therapistContext || null;
    } catch { /* empty body is fine */ }

    // ═══ CHECK EXISTING AUTO PLAN (only block auto, not manual) ═══
    if (!forcePart) {
      const { data: autoPlans } = await sb.from("did_daily_session_plans")
        .select("id, generated_by")
        .eq("plan_date", todayPrague)
        .eq("generated_by", "auto");

      if (autoPlans && autoPlans.length > 0) {
        console.log(`[auto-session-plan] Auto plan already exists for ${todayPrague}, skipping.`);
        return new Response(JSON.stringify({ success: true, skipped: true, reason: "plan_exists" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // NOTE: Manual override (forcePart) always INSERTs a new plan, never deletes old ones

    // ═══ PRIORITY 1: OVERDUE ESCALATION — update overdue_days for old pending plans ═══
    const overduePartBonus = new Map<string, number>();
    {
      const { data: overduePlans } = await sb.from("did_daily_session_plans")
        .select("id, plan_date, selected_part")
        .eq("status", "generated")
        .lt("plan_date", todayPrague);

      if (overduePlans?.length) {
        for (const op of overduePlans) {
          const days = Math.floor((new Date(todayPrague).getTime() - new Date(op.plan_date).getTime()) / (24 * 60 * 60 * 1000));
          await sb.from("did_daily_session_plans")
            .update({ overdue_days: days, updated_at: new Date().toISOString() })
            .eq("id", op.id);
          overduePartBonus.set(op.selected_part, (overduePartBonus.get(op.selected_part) || 0) + 3);
        }
        console.log(`[auto-session-plan] Overdue escalation: ${overduePlans.length} plans, bonuses: ${JSON.stringify(Object.fromEntries(overduePartBonus))}`);
      }
    }

    // ═══ PRIORITY 3: LOAD RECENT SESSIONS (48h) for repetition penalty ═══
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { data: recentSessions48h } = await sb.from("did_part_sessions")
      .select("part_name")
      .gte("session_date", cutoff48h);
    const recentPartNames48h = new Set((recentSessions48h || []).map((s: any) => s.part_name));

    // ═══ GATHER DATA ═══
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoff3d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const [registryRes, threads3dRes, threads24hRes, crisisRes, tasksRes, sessionsRes, profileRes] = await Promise.all([
      sb.from("did_part_registry").select("*"),
      sb.from("did_threads").select("part_name, sub_mode, last_activity_at, messages").gte("last_activity_at", cutoff3d),
      sb.from("did_threads").select("part_name, sub_mode, last_activity_at, messages").gte("last_activity_at", cutoff24h),
      sb.from("crisis_briefs").select("scenario, raw_brief, risk_score").gte("created_at", cutoff24h),
      sb.from("did_therapist_tasks").select("task, category, status, assigned_to, status_hanka, status_kata").in("status", ["pending", "not_started", "in_progress"]),
      sb.from("did_part_sessions").select("part_name, session_date, therapist, methods_used, ai_analysis, karel_notes").order("session_date", { ascending: false }).limit(30),
      sb.from("did_system_profile").select("goals_short_term, goals_mid_term, goals_long_term, current_priorities, risk_factors, integration_strategy").limit(1).maybeSingle(),
    ]);

    const registry = registryRes.data || [];
    const threads3d = threads3dRes.data || [];
    const threads24h = threads24hRes.data || [];
    const crisisBriefs = crisisRes.data || [];
    const pendingTasks = tasksRes.data || [];
    const sessions = sessionsRes.data || [];
    const sysProfile = profileRes.data;

    if (registry.length === 0) {
      console.log("[auto-session-plan] No parts in registry.");
      return new Response(JSON.stringify({ success: false, reason: "no_parts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ CHECK 48h GLOBAL INACTIVITY ═══
    const anyActive48h = registry.some(p => {
      const lastSeen = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
      return (Date.now() - lastSeen) < 48 * 60 * 60 * 1000;
    });

    // ═══ CALCULATE URGENCY SCORES v2 ═══
    const scores = calculateUrgencyScores(registry, threads3d, threads24h, crisisBriefs, pendingTasks, sessions);

    // ═══ PRIORITY 1: Apply overdue escalation bonus ═══
    for (const s of scores) {
      const bonus = overduePartBonus.get(s.partName) || 0;
      if (bonus > 0) {
        s.score += bonus;
        s.breakdown["overdue_escalation"] = bonus;
      }
    }

    // ═══ PRIORITY 3: Apply 48h repetition penalty ═══
    for (const s of scores) {
      if (recentPartNames48h.has(s.partName)) {
        s.score -= 5;
        s.breakdown["recent_session"] = -5;
      }
    }

    // Re-sort after bonuses/penalties
    scores.sort((a, b) => {
      const tierOrder: Record<string, number> = { fading: 0, active: 1, sleeping: 2, override: -1 };
      const tierDiff = (tierOrder[a.tier] ?? 2) - (tierOrder[b.tier] ?? 2);
      if (tierDiff !== 0) return tierDiff;
      return b.score - a.score;
    });

    console.log(`[auto-session-plan] Scores (after bonuses): ${scores.slice(0, 5).map(s => `${s.partName}=${s.score}(${s.tier})`).join(", ")}`);

    // ═══ PART SELECTION ═══
    let selectedPart: UrgencyResult;
    let selectedTier: string;

    if (forcePart) {
      // THERAPIST OVERRIDE — allows any part including sleeping
      const forceCanon = canonicalText(forcePart);
      const partExists = registry.find(p =>
        p.part_name.toLowerCase() === forcePart!.toLowerCase() ||
        canonicalText(p.part_name) === forceCanon
      );
      const resolvedName = partExists ? partExists.part_name : forcePart;
      const partReg = partExists;
      selectedTier = partReg?.status === "active" || partReg?.status === "aktivní" ? "active" : "sleeping";
      selectedPart = {
        partName: resolvedName,
        score: 99,
        breakdown: { therapist_override: 99 },
        tier: "override",
      };
      console.log(`[auto-session-plan] Therapist override: ${resolvedName}`);
    } else {
      // ═══ STRICT TIER FILTERING — EXCLUDE sleeping/dormant from auto-selection ═══
      const activeParts = scores.filter(s => s.tier !== "sleeping");

      if (activeParts.length === 0) {
        // NO active/communicating parts → do NOT generate plan
        console.log("[auto-session-plan] Žádná aktivní/komunikující část nenalezena pro dnešek. Plán nebude vygenerován.");
        return new Response(JSON.stringify({
          success: false,
          reason: "no_active_parts",
          message: "Žádná aktivní/komunikující část nenalezena pro dnešek.",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══ SESSION TARGET GATE — verify part is confirmed AND communicable ═══
      // Load entity registry with Drive token for authoritative resolution
      let entityRegistry;
      try {
        const driveToken = await getAccessToken();
        entityRegistry = await loadEntityRegistry(sb, driveToken);
      } catch {
        entityRegistry = await loadEntityRegistry(sb);
      }

      // Try candidates in urgency order until one passes session-target gate
      let selectedCandidate: typeof activeParts[0] | null = null;
      for (const candidate of activeParts) {
        // Communicability evidence: part has recent thread activity (not just last_seen_at)
        const hasRecentThreads = threads24h.some(t => t.part_name === candidate.partName);
        const resolved = resolveEntity(candidate.partName, entityRegistry, hasRecentThreads);

        if (resolved.can_be_session_target) {
          selectedCandidate = candidate;
          break;
        }
        console.log(`[auto-session-plan] ${candidate.partName}: can_be_session_target=false (${resolved.reasons.join("; ")}), trying next`);
      }

      if (!selectedCandidate) {
        console.log("[auto-session-plan] No part passed session-target gate.");
        return new Response(JSON.stringify({
          success: false,
          reason: "no_session_target",
          message: "Žádná část neprošla session-target gate (potvrzená + komunikovatelná).",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      selectedPart = selectedCandidate;
      selectedTier = selectedPart.tier;
    }

    const partReg = registry.find(p => p.part_name === selectedPart.partName);
    const isDormant = partReg?.status !== "active" && partReg?.status !== "aktivní";

    // Recent sessions for this part
    const partSessions = sessions.filter(s => s.part_name === selectedPart.partName).slice(0, 3);

    // ═══ READ DRIVE DATA — Part card + 00_CENTRUM documents ═══
    let partCard = "";
    let operativePlan = "";
    let centrumDocs = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);

        // Read part card from 01_AKTIVNI_FRAGMENTY
        const aktivniFolder = folders.find(f => f.name.includes("01_AKTIVNI") || f.name.includes("AKTIVNI"));
        if (aktivniFolder) {
          const cards = await listFilesInFolder(token, aktivniFolder.id);
          const match = cards.find(c => canonicalText(c.name).includes(canonicalText(selectedPart.partName)));
          if (match) partCard = truncate(await readFileContent(token, match.id, match.mimeType), 4000);
        }

        // Read 00_CENTRUM documents (Dashboard, Index, Instrukce, Mapa vztahů)
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          // Read key CENTRUM documents
          centrumDocs = await readCentrumDocuments(token, centrumFolder.id);

          // Read operative plan from 05_PLAN subfolder
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFolder = centrumFiles.find(f => f.name.includes("05_PLAN") && f.mimeType?.includes("folder"));
          if (planFolder) {
            const planFiles = await listFilesInFolder(token, planFolder.id);
            const opPlan = planFiles.find(f => f.name.includes("05_Operativni") || f.name.includes("05A_"));
            if (opPlan) operativePlan = truncate(await readFileContent(token, opPlan.id, opPlan.mimeType), 2000);
          }
        }
      }
    } catch (e) {
      console.warn("[auto-session-plan] Drive read failed:", e);
    }

    // ═══ PERPLEXITY RESEARCH — enriched with part-specific diagnosis/needs ═══
    const partNeeds = partReg
      ? `Část "${selectedPart.partName}", věk: ${partReg.age_estimate || "neznámý"}, role: ${partReg.role_in_system || "neznámá"}, emoční stav: ${partReg.last_emotional_state || "neznámý"}, triggery: ${(partReg.known_triggers || []).join(", ") || "žádné"}`
      : `Část "${selectedPart.partName}"`;

    const perplexityResult = await searchPerplexity(
      `Evidence-based terapeutické techniky pro práci s DID alter: ${partNeeds}.${isDormant ? " Část je spící/dormantní — aktivační strategie." : ""} Doporuč kreativní a efektivní aktivity pro 60minutové sezení. Trauma-informed přístupy, IFS, arteterapie, narativní techniky. Bez dechových cvičení (epilepsie).`
    );

    // ═══ GOALS BLOCK ═══
    const goalsBlock = sysProfile ? `
KRÁTKODOBÉ CÍLE: ${(sysProfile.goals_short_term || []).join(", ")}
STŘEDNĚDOBÉ CÍLE: ${(sysProfile.goals_mid_term || []).join(", ")}
DLOUHODOBÉ CÍLE: ${(sysProfile.goals_long_term || []).join(", ")}
PRIORITY: ${(sysProfile.current_priorities || []).join(", ")}
RIZIKA: ${(sysProfile.risk_factors || []).join(", ")}` : "";

    // ═══ STABILIZATION MODE ═══
    const stabilizationMode = !anyActive48h;

    // ═══ AI GENERATION ═══
    const sessionLeadInstruction = `
VŽDY na začátku plánu uveď na prvním řádku:
**VEDE:** HANKA (osobně) nebo KÁŤA (distančně: chat/video/telefon/SMS) nebo HANKA + KÁŤA (kombinované)

Pravidla pro výběr vedoucí:
- Trauma, krize, emocionální témata, regresivní práce → VEDE: HANKA (osobně)
- Kognitivní práce, check-in, úkoly, edukace, monitoring → VEDE: KÁŤA (distančně: chat)
- Pokud obojí, uveď: **VEDE:** HANKA + KÁŤA (kombinované)
  a vygeneruj sekci:
  ## 🤝 Předávací zpráva Hanka → Káťa
  **HANKA vede (osobně, ___ min):** [co konkrétně udělat] [na co si dát pozor]
  **Předat Káťe:** [klíčové body ze sezení] [emoční stav části na konci]
  **KÁŤA navazuje (distančně – chat/video/telefon, ___ min):** [konkrétní otázky k položení] [úkoly k zadání]`;

    const systemPrompt = stabilizationMode
      ? `Jsi Karel, vedoucí DID terapeutického týmu. Žádná část nebyla aktivní 48 hodin.
Sestav UDRŽOVACÍ / STABILIZAČNÍ plán sezení (60 min). Zaměř se na:
- Obecnou stabilizaci systému
- Regulační techniky (BEZ dechových cvičení – epilepsie!)
- Jemné oslovení části s nejvyšší naléhavostí: "${selectedPart.partName}"
- Monitoring a prevenci

NIKDY nepoužívej dechová cvičení. Klientka má epilepsii.
NIKDY nenavrhuj sezení s Locíkem (je to pes), Káťou (je terapeutka) ani s jinými entitami které NEJSOU DID části.
ŽÁDNÉ intimní oslovení ("miláčku", "lásko") – používej "Hani"/"Haničko" a "Káťo".
Návrh sezení MUSÍ obsahovat: konkrétní techniku, 2-3 cíle, otevírací větu, co dělat při neresponzivitě.

${sessionLeadInstruction}

Formát: Markdown, česky. Začni ## 🛡️ Stabilizační plán sezení (60 min)`
      : `Jsi Karel, top-tier AI terapeut pro DID. Automaticky sestavuješ DENNÍ PLÁN SEZENÍ.

Vybraná část: "${selectedPart.partName}" (skóre naléhavosti: ${selectedPart.score}, tier: ${selectedPart.tier})
Důvody výběru: ${Object.entries(selectedPart.breakdown).map(([k, v]) => `${k}: +${v}`).join(", ")}
${selectedPart.tier === "fading" ? `\n🔶 FADING ALERT: Část "${selectedPart.partName}" byla aktivní v posledních 3 dnech, ale posledních 24h se ODMLČELA. Plán musí zohlednit možné důvody odmlčení a strategii jemného obnovení kontaktu.\n` : ""}${selectedPart.tier === "sleeping" ? `\n⚠️ DORMANCY GUARD: Část "${selectedPart.partName}" je SPÍCÍ/DORMANTNÍ (status: ${partReg?.status}). Plán MUSÍ začít AKTIVAČNÍ STRATEGIÍ. Nepředpokládej okamžitou responzivitu.\n` : ""}${selectedPart.tier === "override" ? `\n✅ THERAPIST OVERRIDE: Terapeutka explicitně zvolila "${selectedPart.partName}" pro dnešní sezení.\n` : ""}${therapistContext ? `\n🗣️ PREFERENCE TERAPEUTKY: Terapeutka poskytla konkrétní kontext a témata, která si přeje na sezení zpracovat:\n"${therapistContext}"\n\nTato témata a podněty mají NEJVYŠŠÍ PRIORITU při sestavování plánu sezení. Zakomponuj je do hlavního cíle a aktivit. Přizpůsob celý plán tak, aby reflektoval aktuální situaci popsanou terapeutkou.\n` : ""}

PRAVIDLA:
- NIKDY nepoužívej dechová cvičení — klientka má epilepsii
- Buď KONKRÉTNÍ — žádné obecné fráze
- Navrhuj kreativní techniky (arteterapie, sandplay, IFS, narativní techniky, imaginace)
- Pro spící části: aktivační strategie → test přítomnosti → alternativní plán
- Formát A/B: Pokud je to pro Káťu, připrav i zjednodušenou variantu
- NIKDY nenavrhuj sezení s Locíkem (pes), Káťou (terapeutka) ani s entitami které NEJSOU DID části
- ŽÁDNÉ intimní oslovení ("miláčku", "lásko") – používej "Hani"/"Haničko" a "Káťo"
- Návrh MUSÍ obsahovat: konkrétní techniku, 2-3 cíle, otevírací větu, co dělat při neresponzivitě
- NIKDY do plánu nezařazuj osobní emoce terapeutek, pocit viny ani doporučení pro osobní terapii
${therapistContext ? `- Zohledni preference a kontext terapeutky jako PRIMÁRNÍ vstup pro plánování sezení\n` : ""}
${sessionLeadInstruction}

Formát: Markdown, česky.
## 🎯 Automatický plán sezení: ${selectedPart.partName} (60 min)
### Datum: ${todayPrague}
### Skóre naléhavosti: ${selectedPart.score}/16

### ⏰ Struktura (časové bloky)
### 🌟 Hlavní cíl
### 🎨 Aktivity a techniky
### 🔗 Návaznost na terapeutický plán
### ⚠️ Na co dát pozor
### 📋 Po sezení`;

    const userContent = `
═══ KARTA ČÁSTI ═══
${partCard || "(karta nedostupná — NELZE generovat plán na míru bez karty, udělej maximum z ostatních zdrojů)"}

═══ 00_CENTRUM DOKUMENTY ═══
${centrumDocs || "(nedostupné)"}

═══ OPERATIVNÍ PLÁN ═══
${operativePlan || "(nedostupný)"}

═══ CÍLE SYSTÉMU ═══
${goalsBlock || "(nedostupné)"}

═══ REGISTR ČÁSTI ═══
${partReg ? `Status: ${partReg.status}, Cluster: ${partReg.cluster}, Věk: ${partReg.age_estimate}, Role: ${partReg.role_in_system}, Jazyk: ${partReg.language}, Triggery: ${(partReg.known_triggers || []).join(", ")}, Silné stránky: ${(partReg.known_strengths || []).join(", ")}, Emoce: ${partReg.last_emotional_state} (${partReg.last_emotional_intensity})` : "(nedostupné)"}

═══ HISTORIE SEZENÍ ═══
${partSessions.map((s: any) => `[${s.session_date}] ${s.therapist}: Metody: ${(s.methods_used || []).join(", ")}. ${truncate(s.ai_analysis || "", 200)}`).join("\n") || "(žádná)"}

═══ SKÓRE VŠECH ČÁSTÍ ═══
${scores.slice(0, 8).map(s => `${s.partName}: ${s.score} (${Object.keys(s.breakdown).join(", ")})`).join("\n")}

═══ PERPLEXITY REŠERŠE ═══
${perplexityResult || "(nedostupná)"}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!aiResponse.ok) {
      const err = await aiResponse.text();
      throw new Error(`AI generation failed: ${err}`);
    }

    const aiData = await aiResponse.json();
    const planMarkdown = aiData.choices?.[0]?.message?.content || "";
    if (!planMarkdown) throw new Error("AI returned empty plan");

    // ═══ PARSE SESSION LEAD ═══
    const { lead: sessionLead, format: sessionFormat } = parseSessionLead(planMarkdown);

    // ═══ CONVERT TO HTML ═══
    const planHtml = planMarkdown
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");

    // ═══ SAVE TO DB (INSERT — never delete old plans) ═══
    const generatedBy = forcePart ? "manual" : "auto";
    const { error: insertErr } = await sb.from("did_daily_session_plans").insert({
      user_id: userId,
      plan_date: todayPrague,
      selected_part: selectedPart.partName,
      urgency_score: selectedPart.score,
      urgency_breakdown: selectedPart.breakdown,
      plan_markdown: planMarkdown,
      plan_html: planHtml,
      therapist: sessionLead,
      status: "generated",
      generated_by: generatedBy,
      part_tier: selectedTier || selectedPart.tier,
      session_lead: sessionLead,
      session_format: sessionFormat,
    });

    if (insertErr) {
      console.error("[auto-session-plan] DB insert failed:", insertErr);
      throw insertErr;
    }

    // ═══ CREATE OPERATIVE TASK ═══
    const taskText = `Sezení s ${selectedPart.partName} (${generatedBy === "auto" ? "auto-plán" : "manuální plán"} ${todayPrague})`;
    const { data: existingTask } = await sb.from("did_therapist_tasks")
      .select("id")
      .ilike("task", `%${selectedPart.partName}%`)
      .ilike("task", "%plán%")
      .eq("status", "pending")
      .maybeSingle();

    if (!existingTask) {
      await sb.from("did_therapist_tasks").insert({
        task: taskText,
        detail_instruction: `Karel ${generatedBy === "auto" ? "automaticky" : "na žádost terapeutky"} vybral část "${selectedPart.partName}" na základě skóre naléhavosti ${selectedPart.score}. VEDE: ${sessionLead === "kata" ? "Káťa" : "Hanka"} (${sessionFormat}). Důvody: ${Object.entries(selectedPart.breakdown).map(([k, v]) => `${k}(+${v})`).join(", ")}.`,
        assigned_to: sessionLead === "kata" ? "kata" : "hanka",
        priority: selectedPart.score >= 5 ? "high" : selectedPart.score >= 3 ? "normal" : "low",
        task_tier: "operative",
        status: "pending",
        category: "session",
        due_date: todayPrague,
      });
    }

    // ═══ WRITE TO DRIVE (05_Operativni_Plan) ═══
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFolder = centrumFiles.find(f => f.name.includes("05_PLAN") && f.mimeType?.includes("folder"));
          if (planFolder) {
            const planFiles = await listFilesInFolder(token, planFolder.id);
            const opPlan = planFiles.find(f => f.name.includes("05_Operativni") || f.name.includes("05A_"));
            if (opPlan) {
              const header = `\n\n══════════════════════════════════════\n🎯 ${generatedBy === "auto" ? "AUTOMATICKÝ" : "MANUÁLNÍ"} PLÁN SEZENÍ — ${todayPrague}\nČást: ${selectedPart.partName} | Naléhavost: ${selectedPart.score} | VEDE: ${sessionLead === "kata" ? "Káťa" : "Hanka"} (${sessionFormat})\n══════════════════════════════════════\n`;
              await appendToGoogleDoc(token, opPlan.id, header + planMarkdown);
              // Mark distributed — update the newest plan for today
              const { data: latestPlan } = await sb.from("did_daily_session_plans")
                .select("id")
                .eq("plan_date", todayPrague)
                .eq("selected_part", selectedPart.partName)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (latestPlan) {
                await sb.from("did_daily_session_plans")
                  .update({ distributed_drive: true })
                  .eq("id", latestPlan.id);
              }
              console.log("[auto-session-plan] Written to Drive.");
            }
          }
        }
      }
    } catch (e) {
      console.warn("[auto-session-plan] Drive write failed:", e);
    }

    console.log(`[auto-session-plan] Plan generated for ${selectedPart.partName} (score=${selectedPart.score}, lead=${sessionLead})`);

    return new Response(JSON.stringify({
      success: true,
      selectedPart: selectedPart.partName,
      urgencyScore: selectedPart.score,
      breakdown: selectedPart.breakdown,
      stabilizationMode,
      sessionLead,
      sessionFormat,
      generatedBy,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[auto-session-plan] Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
