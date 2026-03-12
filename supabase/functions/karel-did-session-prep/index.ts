import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// OAuth2 token helper
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

// Drive helpers
async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return allFiles;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { partName } = await req.json();
    if (!partName || typeof partName !== "string") {
      return new Response(JSON.stringify({ error: "partName is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // Parallel: fetch DB data + Drive data
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [threadsResult, tasksResult, patternsResult, driveData] = await Promise.allSettled([
      // Recent threads for this part
      supabase.from("did_threads")
        .select("messages, started_at, last_activity_at, sub_mode")
        .eq("part_name", partName)
        .gte("last_activity_at", thirtyDaysAgo)
        .order("last_activity_at", { ascending: false })
        .limit(5),
      // Pending tasks
      supabase.from("did_therapist_tasks")
        .select("task, note, status, status_hanka, status_kata, assigned_to, source_agreement, completed_note")
        .neq("status", "done")
        .order("created_at", { ascending: false }),
      // Recent weekly cycle reports
      supabase.from("did_update_cycles")
        .select("report_summary, completed_at, cycle_type")
        .eq("status", "completed")
        .gte("completed_at", sevenDaysAgo)
        .order("completed_at", { ascending: false })
        .limit(3),
      // Drive: part card + centrum docs
      (async () => {
        const token = await getAccessToken();
        const kartotekaId = await findFolder(token, "kartoteka_DID");
        if (!kartotekaId) return { partCard: "", therapyPlan: "", agreements: "" };

        const folders = await listFilesInFolder(token, kartotekaId);
        let partCard = "";
        let therapyPlan = "";
        let agreements = "";

        // Find part card in 01_AKTIVNI_FRAGMENTY
        const aktivniFolder = folders.find(f => f.name.includes("01_AKTIVNI_FRAGMENTY") || f.name.includes("AKTIVNI"));
        if (aktivniFolder) {
          const cards = await listFilesInFolder(token, aktivniFolder.id);
          const partCanonical = canonicalText(partName);
          const match = cards.find(c => canonicalText(c.name).includes(partCanonical));
          if (match) {
            partCard = truncate(await readFileContent(token, match.id), 3000);
          }
        }

        // 05_Operativni_Plan (or legacy 05_Terapeuticky)
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFile = centrumFiles.find(f => f.name.includes("05_Operativni") || f.name.includes("05_Terapeuticky") || f.name.includes("Terapeuticky_Plan"));
          if (planFile) therapyPlan = truncate(await readFileContent(token, planFile.id), 2000);

          // 06_Strategicky_Vyhled (or legacy 06_Terapeuticke)
          const strategicFile = centrumFiles.find(f => 
            f.name.includes("06_Strategicky") || f.name.includes("Strategicky_Vyhled") ||
            f.name.includes("06_Terapeuticke") || f.name.includes("Dohody")
          );
          if (strategicFile && strategicFile.mimeType !== "application/vnd.google-apps.folder") {
            agreements = truncate(await readFileContent(token, strategicFile.id), 2000);
          }
        }

        return { partCard, therapyPlan, agreements };
      })(),
    ]);

    // Extract results
    const threads = threadsResult.status === "fulfilled" ? threadsResult.value.data || [] : [];
    const tasks = tasksResult.status === "fulfilled" ? tasksResult.value.data || [] : [];
    const cycles = patternsResult.status === "fulfilled" ? patternsResult.value.data || [] : [];
    const drive = driveData.status === "fulfilled" ? driveData.value : { partCard: "", therapyPlan: "", agreements: "" };

    // Build conversation summaries
    const conversationSummaries = threads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-6).map((m: any) => `${m.role === "user" ? "Klient" : "Karel"}: ${truncate(m.content || "", 200)}`).join("\n");
      return `[${new Date(t.last_activity_at).toLocaleDateString("cs-CZ")}] (${t.sub_mode})\n${lastMsgs}`;
    }).join("\n---\n");

    // Build task list
    const taskList = tasks.map((t: any) => {
      const statusH = t.status_hanka || "?";
      const statusK = t.status_kata || "?";
      return `- ${t.task} [H:${statusH} K:${statusK}] ${t.note ? `(${truncate(t.note, 100)})` : ""}`;
    }).join("\n");

    // Build cycle summaries
    const cycleSummaries = cycles.map((c: any) => truncate(c.report_summary || "", 500)).join("\n---\n");

    const systemPrompt = `Jsi Karel, specializovaný AI asistent pro terapii DID (disociativní porucha identity).
Připravuješ pro terapeutku strukturovaný briefing před sezením s částí "${partName}".

FORMÁT VÝSTUPU (vždy česky, markdown):

## 📋 Příprava na sezení: ${partName}

### 🔄 Co se dělo v posledních rozhovorech
(Shrnutí klíčových témat, emocí, dynamik z posledních konverzací)

### 🎯 Na co navázat
(Konkrétní body k pokračování, nedořešená témata, sliby)

### ⚠️ Co sledovat
(Rizika, triggery, warning signs z karty části)

### 💡 Doporučené metody a techniky
(Na základě terapeutického plánu a toho co funguje u této části)

### ✅ Relevantní úkoly a dohody
(Nedokončené úkoly, platné terapeutické dohody)

### 📝 Karlova doporučení
(Tvé vlastní postřehy a návrhy pro terapeutku)

Buď konkrétní, stručný a klinicky užitečný. Nepoužívej obecné fráze.
DŮLEŽITÉ: Nikdy nepoužívej dechová cvičení — klientka má epilepsii.`;

    const userContent = `KARTA ČÁSTI "${partName}":
${drive.partCard || "(karta nenalezena)"}

OPERATIVNÍ PLÁN:
${drive.therapyPlan || "(nenalezen)"}

STRATEGICKÝ VÝHLED:
${drive.agreements || "(nenalezen)"}

POSLEDNÍ ROZHOVORY S ČÁSTÍ:
${conversationSummaries || "(žádné nedávné rozhovory)"}

NEDOKONČENÉ ÚKOLY:
${taskList || "(žádné)"}

POSLEDNÍ REPORTY:
${cycleSummaries || "(žádné)"}`;

    // Stream via Lovable AI
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: true,
      }),
    });

    if (!aiResp.ok) {
      const status = aiResp.status;
      if (status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      if (status === 402) return new Response(JSON.stringify({ error: "Credits exhausted" }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      throw new Error(`AI gateway error: ${status}`);
    }

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("session-prep error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
