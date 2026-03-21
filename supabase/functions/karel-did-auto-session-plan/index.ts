import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-did-auto-session-plan
 * 
 * Automatic daily session plan generator (triggered at 13:50 CET by cron).
 * 
 * 1. Calculates URGENCY SCORE for each part in registry
 * 2. Selects the top-scoring part
 * 3. Generates a 60min session plan via AI
 * 4. Stores in did_daily_session_plans
 * 5. Writes to Drive (05_PLAN/05_Operativni_Plan)
 * 6. Creates operative task in did_therapist_tasks
 * 
 * Urgency scoring (from system instructions):
 *   Krizový stav (crisis brief 24h):       +5
 *   Noční můry / flashbacky (tags):        +4
 *   Emoční dysregulace (intensity ≥4):     +3
 *   Nedokončený úkol z minulého sezení:    +2
 *   Nedávná aktivita (24h):                +2
 *   Spící část >7 dní neaktivní:           +1
 *   48h žádná část aktivní (stabilizace):  special
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

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return await exportRes.text();
  }
  return await res.text();
}

async function appendToGoogleDoc(token: string, fileId: string, text: string): Promise<void> {
  // Get current doc length
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
// Priority tiers:
//   1. FADING: was active (cast thread) in last 3d but silent last 24h → highest (+6)
//   2. ACTIVE: has cast thread in last 3d → high (+4)
//   3. SLEEPING: no cast thread in 3d → allowed but lower (+1 max from dormancy)
//   Therapist override bypasses all scoring.

interface UrgencyResult {
  partName: string;
  score: number;
  breakdown: Record<string, number>;
  tier: "fading" | "active" | "sleeping" | "override";
}

function calculateUrgencyScores(
  registry: any[],
  threads3d: any[],   // cast threads from last 3 days
  threads24h: any[],  // cast threads from last 24h
  crisisBriefs24h: any[],
  pendingTasks: any[],
  sessions: any[],
): UrgencyResult[] {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // Crisis briefs mentioning parts
  const crisisPartNames = new Set<string>();
  for (const brief of crisisBriefs24h) {
    for (const part of registry) {
      if (brief.scenario?.toLowerCase().includes(part.part_name.toLowerCase()) ||
          brief.raw_brief?.toLowerCase().includes(part.part_name.toLowerCase())) {
        crisisPartNames.add(part.part_name);
      }
    }
  }

  // Direct activity (cast mode) in last 3 days
  const activeParts3d = new Set<string>();
  for (const t of threads3d) {
    if (t.sub_mode === "cast") activeParts3d.add(t.part_name);
  }

  // Direct activity (cast mode) in last 24h
  const activeParts24h = new Set<string>();
  for (const t of threads24h) {
    if (t.sub_mode === "cast") activeParts24h.add(t.part_name);
  }

  // Pending tasks by part
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

    // Determine tier
    let tier: "fading" | "active" | "sleeping";
    if (wasActive3d && !isActive24h) {
      tier = "fading";
      // FADING: was active in 3d, silent now → HIGHEST priority
      breakdown["fading_alert"] = 6;
      score += 6;
    } else if (wasActive3d) {
      tier = "active";
      // ACTIVE: currently communicating
      breakdown["active_3d"] = 4;
      score += 4;
    } else {
      tier = "sleeping";
      // SLEEPING: no direct activity in 3d
      // Still allowed but much lower base
      const lastSeen = part.last_seen_at ? new Date(part.last_seen_at).getTime() : 0;
      const daysSinceLastSeen = lastSeen ? (now - lastSeen) / DAY : Infinity;
      if (daysSinceLastSeen > 7) {
        breakdown["dormant_7d"] = 1;
        score += 1;
      }
    }

    // Crisis bonus (any tier)
    if (crisisPartNames.has(part.part_name)) {
      breakdown["crisis"] = 5;
      score += 5;
    }

    // Nightmares/flashbacks
    const triggers = (part.known_triggers || []).map((t: string) => t.toLowerCase());
    const hasNightmares = triggers.some((t: string) => t.includes("noční") || t.includes("flashback") || t.includes("nightmare"));
    const emoState = (part.last_emotional_state || "").toLowerCase();
    if (hasNightmares || emoState.includes("flashback") || emoState.includes("nocni")) {
      breakdown["nightmares_flashbacks"] = 4;
      score += 4;
    }

    // Emotional dysregulation
    if ((part.last_emotional_intensity || 0) >= 4) {
      breakdown["emotional_dysregulation"] = 3;
      score += 3;
    }

    // Pending tasks
    if ((tasksByPart.get(part.part_name) || 0) > 0) {
      breakdown["pending_tasks"] = 2;
      score += 2;
    }

    return { partName: part.part_name, score, breakdown, tier };
  }).sort((a, b) => {
    // Sort by tier priority first, then score
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Accept cron (service_role/anon) and manual (authenticated)
  const authHeader = req.headers.get("Authorization") || "";
  const isCron = req.headers.get("user-agent")?.includes("pg_net") ||
    authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY") || "___none___");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const sb = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const todayPrague = getPragueDate();

  // Get user_id - from auth or fallback to first registry user
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
    // Parse request body for therapist override
    let forcePart: string | null = null;
    let therapistContext: string | null = null;
    try {
      const body = await req.json();
      forcePart = body?.forcePart || null;
      therapistContext = body?.therapistContext || null;
    } catch { /* empty body is fine */ }

    // Check if plan already exists for today
    const { data: existingPlan } = await sb.from("did_daily_session_plans")
      .select("id")
      .eq("plan_date", todayPrague)
      .maybeSingle();

    if (existingPlan && !forcePart) {
      console.log(`[auto-session-plan] Plan already exists for ${todayPrague}, skipping.`);
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "plan_exists" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Delete old plan if therapist override
    if (existingPlan && forcePart) {
      console.log(`[auto-session-plan] Therapist override: deleting existing plan for ${todayPrague}`);
      await sb.from("did_daily_session_plans").delete().eq("id", existingPlan.id);
    }

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
    console.log(`[auto-session-plan] Scores: ${scores.slice(0, 5).map(s => `${s.partName}=${s.score}(${s.tier})`).join(", ")}`);

    // ═══ THERAPIST OVERRIDE ═══
    let selectedPart: UrgencyResult;
    if (forcePart) {
      const partExists = registry.find(p => p.part_name.toLowerCase() === forcePart!.toLowerCase());
      if (!partExists) {
        return new Response(JSON.stringify({ error: `Část "${forcePart}" nenalezena v registru` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      selectedPart = {
        partName: partExists.part_name,
        score: 99,
        breakdown: { therapist_override: 99 },
        tier: "override",
      };
      console.log(`[auto-session-plan] Therapist override: ${partExists.part_name}`);
    } else {
      selectedPart = scores[0];
      if (!selectedPart || selectedPart.score === 0) {
        const oldest = [...registry].sort((a, b) => {
          const aTime = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
          const bTime = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
          return aTime - bTime;
        })[0];
        if (oldest) {
          selectedPart = {
            partName: oldest.part_name,
            score: 0.5,
            breakdown: { fallback_oldest: 0.5 },
            tier: "sleeping",
          };
        }
      }
    }

    const partReg = registry.find(p => p.part_name === selectedPart.partName);
    const isDormant = partReg?.status !== "active" && partReg?.status !== "aktivní";

    // Recent sessions for this part
    const partSessions = sessions.filter(s => s.part_name === selectedPart.partName).slice(0, 3);

    // ═══ PERPLEXITY RESEARCH ═══
    const perplexityResult = await searchPerplexity(
      `Nejlepší terapeutické techniky pro práci s DID alter "${selectedPart.partName}"${isDormant ? " (spící/dormantní část - aktivační strategie)" : ""}. Doporuč kreativní a efektivní aktivity pro 60minutové sezení. Trauma-informed přístupy, IFS, arteterapie, narativní techniky.`
    );

    // ═══ READ DRIVE DATA ═══
    let partCard = "";
    let operativePlan = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);
        const aktivniFolder = folders.find(f => f.name.includes("01_AKTIVNI") || f.name.includes("AKTIVNI"));
        if (aktivniFolder) {
          const cards = await listFilesInFolder(token, aktivniFolder.id);
          const match = cards.find(c => canonicalText(c.name).includes(canonicalText(selectedPart.partName)));
          if (match) partCard = truncate(await readFileContent(token, match.id), 4000);
        }
        // Read operative plan
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFolder = centrumFiles.find(f => f.name.includes("05_PLAN") && f.mimeType?.includes("folder"));
          if (planFolder) {
            const planFiles = await listFilesInFolder(token, planFolder.id);
            const opPlan = planFiles.find(f => f.name.includes("05_Operativni") || f.name.includes("05A_"));
            if (opPlan) operativePlan = truncate(await readFileContent(token, opPlan.id), 2000);
          }
        }
      }
    } catch (e) {
      console.warn("[auto-session-plan] Drive read failed:", e);
    }

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
    const systemPrompt = stabilizationMode
      ? `Jsi Karel, vedoucí DID terapeutického týmu. Žádná část nebyla aktivní 48 hodin.
Sestav UDRŽOVACÍ / STABILIZAČNÍ plán sezení (60 min). Zaměř se na:
- Obecnou stabilizaci systému
- Regulační techniky (BEZ dechových cvičení – epilepsie!)
- Jemné oslovení části s nejvyšší naléhavostí: "${selectedPart.partName}"
- Monitoring a prevenci

NIKDY nepoužívej dechová cvičení. Klientka má epilepsii.

Formát: Markdown, česky. Začni ## 🛡️ Stabilizační plán sezení (60 min)`
      : `Jsi Karel, top-tier AI terapeut pro DID. Automaticky sestavuješ DENNÍ PLÁN SEZENÍ.

Vybraná část: "${selectedPart.partName}" (skóre naléhavosti: ${selectedPart.score}, tier: ${selectedPart.tier})
Důvody výběru: ${Object.entries(selectedPart.breakdown).map(([k, v]) => `${k}: +${v}`).join(", ")}
${selectedPart.tier === "fading" ? `\n🔶 FADING ALERT: Část "${selectedPart.partName}" byla aktivní v posledních 3 dnech, ale posledních 24h se ODMLČELA. Plán musí zohlednit možné důvody odmlčení a strategii jemného obnovení kontaktu.\n` : ""}${selectedPart.tier === "sleeping" ? `\n⚠️ DORMANCY GUARD: Část "${selectedPart.partName}" je SPÍCÍ/DORMANTNÍ (status: ${partReg?.status}). Plán MUSÍ začít AKTIVAČNÍ STRATEGIÍ. Nepředpokládej okamžitou responzivitu.\n` : ""}${selectedPart.tier === "override" ? `\n✅ THERAPIST OVERRIDE: Terapeutka explicitně zvolila "${selectedPart.partName}" pro dnešní sezení.\n` : ""}

PRAVIDLA:
- NIKDY nepoužívej dechová cvičení — klientka má epilepsii
- Buď KONKRÉTNÍ — žádné obecné fráze
- Navrhuj kreativní techniky (arteterapie, sandplay, IFS, narativní techniky, imaginace)
- Pro spící části: aktivační strategie → test přítomnosti → alternativní plán
- Formát A/B: Pokud je to pro Káťu, připrav i zjednodušenou variantu

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
${partCard || "(karta nedostupná)"}

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

    // ═══ CONVERT TO HTML ═══
    const planHtml = planMarkdown
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");

    // ═══ SAVE TO DB ═══
    const { error: insertErr } = await sb.from("did_daily_session_plans").insert({
      user_id: userId,
      plan_date: todayPrague,
      selected_part: selectedPart.partName,
      urgency_score: selectedPart.score,
      urgency_breakdown: selectedPart.breakdown,
      plan_markdown: planMarkdown,
      plan_html: planHtml,
      therapist: "hanka",
      status: "generated",
    });

    if (insertErr) {
      console.error("[auto-session-plan] DB insert failed:", insertErr);
      // Might be duplicate
      if ((insertErr as any).code !== "23505") throw insertErr;
    }

    // ═══ CREATE OPERATIVE TASK ═══
    const taskText = `Sezení s ${selectedPart.partName} (auto-plán ${todayPrague})`;
    const { data: existingTask } = await sb.from("did_therapist_tasks")
      .select("id")
      .ilike("task", `%${selectedPart.partName}%`)
      .ilike("task", "%auto-plán%")
      .eq("status", "pending")
      .maybeSingle();

    if (!existingTask) {
      await sb.from("did_therapist_tasks").insert({
        task: taskText,
        detail_instruction: `Karel automaticky vybral část "${selectedPart.partName}" na základě skóre naléhavosti ${selectedPart.score}. Důvody: ${Object.entries(selectedPart.breakdown).map(([k, v]) => `${k}(+${v})`).join(", ")}. Plán sezení je k dispozici v dashboardu.`,
        assigned_to: "hanka",
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
              const header = `\n\n══════════════════════════════════════\n🎯 AUTOMATICKÝ PLÁN SEZENÍ — ${todayPrague}\nČást: ${selectedPart.partName} | Naléhavost: ${selectedPart.score}\n══════════════════════════════════════\n`;
              await appendToGoogleDoc(token, opPlan.id, header + planMarkdown);
              // Mark distributed
              await sb.from("did_daily_session_plans")
                .update({ distributed_drive: true })
                .eq("plan_date", todayPrague);
              console.log("[auto-session-plan] Written to Drive.");
            }
          }
        }
      }
    } catch (e) {
      console.warn("[auto-session-plan] Drive write failed:", e);
    }

    console.log(`[auto-session-plan] Plan generated for ${selectedPart.partName} (score=${selectedPart.score})`);

    return new Response(JSON.stringify({
      success: true,
      selectedPart: selectedPart.partName,
      urgencyScore: selectedPart.score,
      breakdown: selectedPart.breakdown,
      stabilizationMode,
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
