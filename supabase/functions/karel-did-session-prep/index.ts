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

async function searchPerplexity(query: string): Promise<string> {
  const key = Deno.env.get("PERPLEXITY_API_KEY");
  if (!key) return "(Perplexity nedostupný)";
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
    if (!res.ok) return "(Perplexity error)";
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const citations = data.citations ? `\nZdroje: ${data.citations.slice(0, 3).join(", ")}` : "";
    return truncate(content, 2000) + citations;
  } catch {
    return "(Perplexity timeout)";
  }
}

async function readTherapistMemory(token: string, therapistKey: string): Promise<string> {
  try {
    const pametId = await findFolder(token, "PAMET_KAREL");
    if (!pametId) return "";
    const didFolder = await findFolder(token, "DID", pametId);
    if (!didFolder) return "";
    const folderName = therapistKey === "hanka" ? "HANKA" : "KATA";
    const tFolder = await findFolder(token, folderName, didFolder);
    if (!tFolder) return "";
    const files = await listFilesInFolder(token, tFolder);
    // Read strategy and situation files (most relevant for session prep)
    const relevantFiles = files.filter(f =>
      f.name.includes("STRATEGIE") || f.name.includes("SITUACNI") || f.name.includes("PROFIL")
    ).slice(0, 3);
    const contents: string[] = [];
    for (const f of relevantFiles) {
      try {
        contents.push(`[${f.name}]\n${truncate(await readFileContent(token, f.id), 1500)}`);
      } catch {}
    }
    return contents.join("\n\n");
  } catch {
    return "";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await req.json();
    const { partName, therapist, therapistDisplayName, goalType, goalText, revision, previousPlan } = body;
    
    if (!partName || typeof partName !== "string") {
      return new Response(JSON.stringify({ error: "partName is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const therapistKey = therapist || "hanka";
    const therapistDisplay = therapistDisplayName || (therapistKey === "kata" ? "Káťa" : "Hanička");
    const isRevision = !!revision && !!previousPlan;

    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // Parallel data fetching
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [threadsResult, tasksResult, cyclesResult, sessionsResult, profileResult, agreementsResult, driveData, perplexityData, therapistMemory] = await Promise.allSettled([
      // Recent threads for this part
      supabase.from("did_threads")
        .select("messages, started_at, last_activity_at, sub_mode")
        .eq("part_name", partName)
        .gte("last_activity_at", thirtyDaysAgo)
        .order("last_activity_at", { ascending: false })
        .limit(5),
      // Pending tasks
      supabase.from("did_therapist_tasks")
        .select("task, note, status, status_hanka, status_kata, assigned_to, source_agreement, completed_note, priority, category")
        .neq("status", "done")
        .order("created_at", { ascending: false }),
      // Recent cycle reports
      supabase.from("did_update_cycles")
        .select("report_summary, completed_at, cycle_type")
        .eq("status", "completed")
        .gte("completed_at", sevenDaysAgo)
        .order("completed_at", { ascending: false })
        .limit(3),
      // Part sessions history
      supabase.from("did_part_sessions")
        .select("session_date, session_type, therapist, ai_analysis, methods_used, short_term_goals, mid_term_goals, long_term_goals, karel_notes")
        .eq("part_name", partName)
        .order("session_date", { ascending: false })
        .limit(5),
      // System profile (goals)
      supabase.from("did_system_profile")
        .select("goals_short_term, goals_mid_term, goals_long_term, current_priorities, integration_strategy, risk_factors")
        .limit(1)
        .maybeSingle(),
      // Part registry info
      supabase.from("did_part_registry")
        .select("*")
        .eq("part_name", partName)
        .maybeSingle(),
      // Drive data
      (async () => {
        const token = await getAccessToken();
        const kartotekaId = await findFolder(token, "kartoteka_DID");
        if (!kartotekaId) return { partCard: "", therapyPlan: "", agreements: "", strategic: "" };

        const folders = await listFilesInFolder(token, kartotekaId);
        let partCard = "";
        let therapyPlan = "";
        let agreements = "";
        let strategic = "";

        // Find part card
        const aktivniFolder = folders.find(f => f.name.includes("01_AKTIVNI_FRAGMENTY") || f.name.includes("AKTIVNI"));
        if (aktivniFolder) {
          const cards = await listFilesInFolder(token, aktivniFolder.id);
          const partCanonical = canonicalText(partName);
          const match = cards.find(c => canonicalText(c.name).includes(partCanonical));
          if (match) partCard = truncate(await readFileContent(token, match.id), 4000);
        }

        // Centrum docs
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFile = centrumFiles.find(f => f.name.includes("05_Operativni") || f.name.includes("05_Terapeuticky"));
          if (planFile) therapyPlan = truncate(await readFileContent(token, planFile.id), 2500);

          const agreementFile = centrumFiles.find(f => f.name.includes("06_Strategicky") || f.name.includes("06_Terapeuticke") || f.name.includes("Dohody"));
          if (agreementFile && agreementFile.mimeType !== "application/vnd.google-apps.folder") {
            agreements = truncate(await readFileContent(token, agreementFile.id), 2000);
          }

          const dashFile = centrumFiles.find(f => f.name.includes("00_Aktualni_Dashboard") || f.name.includes("Dashboard"));
          if (dashFile) strategic = truncate(await readFileContent(token, dashFile.id), 1500);
        }

        return { partCard, therapyPlan, agreements, strategic };
      })(),
      // Perplexity research
      isRevision ? Promise.resolve("") : searchPerplexity(
        `Nejlepší terapeutické techniky pro práci s DID alter "${partName}"${goalType === "specific" ? ` s cílem: ${goalText}` : goalType === "strengthen" ? ` se zaměřením na posílení: ${goalText}` : ""}. Doporuč kreativní, neotřelé a efektivní aktivity pro 60minutové sezení. Zvaž trauma-informed přístupy, IFS, EMDR, arteterapii, sandplay, narativní techniky.`
      ),
      // Therapist memory from PAMET_KAREL
      isRevision ? Promise.resolve("") : (async () => {
        const token = await getAccessToken();
        return await readTherapistMemory(token, therapistKey);
      })(),
    ]);

    // Extract results
    const threads = threadsResult.status === "fulfilled" ? threadsResult.value.data || [] : [];
    const tasks = tasksResult.status === "fulfilled" ? tasksResult.value.data || [] : [];
    const cycles = cyclesResult.status === "fulfilled" ? cyclesResult.value.data || [] : [];
    const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value.data || [] : [];
    const sysProfile = profileResult.status === "fulfilled" ? profileResult.value.data : null;
    const partReg = agreementsResult.status === "fulfilled" ? agreementsResult.value.data : null;
    const drive = driveData.status === "fulfilled" ? driveData.value : { partCard: "", therapyPlan: "", agreements: "", strategic: "" };
    const perplexity = perplexityData.status === "fulfilled" ? perplexityData.value : "";
    const tMemory = therapistMemory.status === "fulfilled" ? therapistMemory.value : "";

    // Build conversation summaries
    const activityLabel = (subMode: string) => subMode === "cast" ? "PŘÍMÁ AKTIVITA (část přímo mluvila)" : "ZMÍNKA (pohled terapeutky, část NEMUSÍ být k dispozici)";
    const conversationSummaries = threads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-6).map((m: any) => `${m.role === "user" ? "Klient" : "Karel"}: ${truncate(m.content || "", 200)}`).join("\n");
      return `[${new Date(t.last_activity_at).toLocaleDateString("cs-CZ")}] [${activityLabel(t.sub_mode)}] (${t.sub_mode})\n${lastMsgs}`;
    }).join("\n---\n");

    // Build task list
    const tn = therapistKey;
    const filteredTasks = tasks.filter((t: any) => t.assigned_to === "both" || t.assigned_to === tn);
    const taskList = filteredTasks.map((t: any) => {
      const st = tn === "hanka" ? t.status_hanka : t.status_kata;
      return `- [${st}] ${t.task} (${t.priority || "normal"}) ${t.note ? `— ${truncate(t.note, 80)}` : ""}`;
    }).join("\n");

    // Build session history
    const sessionHistory = sessions.map((s: any) => {
      return `[${s.session_date}] ${s.therapist} | ${s.session_type}\nMetody: ${(s.methods_used || []).join(", ")}\nAnalýza: ${truncate(s.ai_analysis || "", 300)}\nKarel: ${truncate(s.karel_notes || "", 200)}`;
    }).join("\n---\n");

    // Goals from system profile
    const goalsBlock = sysProfile ? `
KRÁTKODOBÉ CÍLE: ${(sysProfile.goals_short_term || []).join(", ")}
STŘEDNĚDOBÉ CÍLE: ${(sysProfile.goals_mid_term || []).join(", ")}
DLOUHODOBÉ CÍLE: ${(sysProfile.goals_long_term || []).join(", ")}
AKTUÁLNÍ PRIORITY: ${(sysProfile.current_priorities || []).join(", ")}
INTEGRAČNÍ STRATEGIE: ${sysProfile.integration_strategy || ""}
RIZIKOVÉ FAKTORY: ${(sysProfile.risk_factors || []).join(", ")}` : "";

    // Part registry info
    const partInfo = partReg ? `
STATUS: ${partReg.status} | CLUSTER: ${partReg.cluster || "?"} | VĚK: ${partReg.age_estimate || "?"}
ROLE: ${partReg.role_in_system || "?"} | JAZYK: ${partReg.language || "cs"}
TRIGGERY: ${(partReg.known_triggers || []).join(", ")}
SILNÉ STRÁNKY: ${(partReg.known_strengths || []).join(", ")}
EMOČNÍ STAV: ${partReg.last_emotional_state || "?"} (intenzita ${partReg.last_emotional_intensity || "?"})` : "";

    const cycleSummaries = cycles.map((c: any) => truncate(c.report_summary || "", 500)).join("\n---\n");

    // System prompt
    // Dormancy guard
    const partStatus = partReg?.status || "neznámý";
    const isDormant = partStatus !== "active" && partStatus !== "aktivní";
    const dormancyWarning = isDormant
      ? `\n⚠️⚠️⚠️ DORMANCY GUARD ⚠️⚠️⚠️\nČást "${partName}" má status "${partStatus}". Část NEMUSÍ být k dispozici pro přímou práci.\nSezení MUSÍ začít sekcí o AKTIVAČNÍ STRATEGII – jak se pokusit část oslovit/probudit.\nNEPŘEDPOKLÁDEJ že část bude reagovat. Připrav alternativní plán pro případ neaktivace.\nVlákna kde sub_mode != "cast" jsou diskuze terapeutek O části, NE důkaz že je část přítomná.\n`
      : "";

    const systemPrompt = isRevision
      ? `Jsi Karel, AI terapeut pro DID. ${therapistDisplay} ti poslala svůj stávající plán sezení s částí "${partName}" a chce ho upravit.
Uprav plán podle jejího požadavku. Zachovej strukturu a formát, ale zapracuj změny.
DŮLEŽITÉ: Nikdy nepoužívej dechová cvičení — klientka má epilepsii.${dormancyWarning}
Odpověz kompletním upraveným plánem ve stejném formátu.`
      : `Jsi Karel, top-tier AI terapeut specializovaný na DID (disociativní porucha identity).
Připravuješ PERSONALIZOVANÝ plán 60minutového sezení pro terapeutku ${therapistDisplay} s částí "${partName}".
${dormancyWarning}
${therapistKey === "hanka" ? "Hanička je primární terapeutka systému, zkušená a empatická. Oslovuj ji profesionálně ('Haničko')." : "Káťa je spolupracující terapeutka. Oslovuj ji kolegiálně ('Káťo')."}

═══ BIOLOGICKÉ OSOBY A ZVÍŘATA – NEJSOU DID ČÁSTI ═══
⚠️ Následující entity NIKDY nezařazuj jako DID části:
- Hanka, Káťa – TERAPEUTKY
- Karel – AI asistent
- Locík – PES (domácí zvíře)
- Amálka, Tonička – biologické děti Káti
- Jiří – Kátin manžel

═══ TÓN A SOUKROMÍ ═══
- NIKDY nepoužívej intimní oslovení (miláčku, lásko, drahá) – pouze profesionální
- NIKDY nezařazuj soukromé emoční stavy terapeutek do plánu sezení

CÍL TERAPEUTA: ${goalType === "specific" ? `Konkrétní cíl: ${goalText}` : goalType === "strengthen" ? `Chce posílit: ${goalText}` : "Terapeut nemá konkrétní cíl — navrhni optimální plán na základě dat."}

═══ KRITICKÉ PRAVIDLO: AKTIVITA vs. ZMÍNKA ═══
Karel MUSÍ rozlišovat v konverzacích:
- PŘÍMÁ AKTIVITA (sub_mode="cast"): Část přímo mluvila → potvrzená aktivita.
- ZMÍNKA (sub_mode="mamka"/"kata"): Terapeutka O části hovořila → část NEMUSÍ být k dispozici.
Karel NESMÍ:
- Předpokládat že část je aktivní jen proto, že o ní terapeutka mluvila
- Plánovat přímou práci s částí bez ověření jejího statusu
- Zadávat úkoly vyžadující přítomnost spící/dormantní části
Pro spící části smí navrhovat POUZE: monitorování, přípravné kroky, vizualizace, symbolické aktivity.

FORMÁT VÝSTUPU (vždy česky, markdown):

## 🎯 Plán sezení: ${partName} (60 min)
### Personalizováno pro: ${therapistDisplay}

### ⏰ Struktura sezení
(Rozděl na jasné časové bloky: úvod 5-10 min, jádro 35-40 min, závěr 10-15 min. Buď konkrétní v minutách.)

### 🌟 Hlavní cíl sezení
(Jeden jasný, měřitelný cíl propojený s terapeutickým plánem)

### 🎨 Aktivity a techniky
(Pro KAŽDÝ blok navrhni konkrétní aktivitu. Buď KREATIVNÍ a NEOTŘELÝ — ne jen "povídání". Navrhuj arteterapii, sandplay, narativní techniky, IFS dialogy, mikro-hry, metafory, práci s tělem (BEZ dechových cvičení!), imaginace, symbolickou práci. Aktivita musí být zábavná A efektivní.)

### 🔗 Návaznost na terapeutický plán
(Jak toto sezení posouvá krátkodobé/střednědobé/dlouhodobé cíle)

### ⚠️ Na co dát pozor
(Triggery, rizika, specifika části — z karty a historie)

### 💡 Tipy pro ${therapistDisplay}
(Personalizované rady na základě znalosti terapeutky — její styl, silné stránky, na co si dát pozor)

### 📋 Po sezení
(Co zaznamenat, jaké úkoly zadat, co sledovat do příštího sezení)

PRAVIDLA:
- NIKDY nepoužívej dechová cvičení — klientka má epilepsii
- Buď KONKRÉTNÍ — žádné obecné fráze
- Navrhuj KREATIVNÍ aktivity, které budou bavit i terapeutku
- Propoj vše s reálnými daty z karty a historie
- Respektuj věk a jazyk části
- Zohledni aktuální emoční stav a triggery
- NESMÍŠ navrhovat přímou práci se spícími/dormantními částmi`;

    const userContent = isRevision
      ? `STÁVAJÍCÍ PLÁN:\n${previousPlan}\n\nPOŽADAVEK NA ÚPRAVU:\n${revision}`
      : `KARTA ČÁSTI "${partName}":
${drive.partCard || "(karta nenalezena)"}

INFO Z REGISTRU:${partInfo || "\n(nenalezeno)"}

OPERATIVNÍ PLÁN:
${drive.therapyPlan || "(nenalezen)"}

STRATEGICKÝ VÝHLED / DOHODY:
${drive.agreements || "(nenalezeny)"}

AKTUÁLNÍ DASHBOARD:
${drive.strategic || "(nenalezen)"}

TERAPEUTICKÉ CÍLE SYSTÉMU:${goalsBlock || "\n(nenalezeny)"}

HISTORIE SEZENÍ S TOUTO ČÁSTÍ:
${sessionHistory || "(žádná předchozí sezení)"}

POSLEDNÍ ROZHOVORY S ČÁSTÍ:
${conversationSummaries || "(žádné nedávné rozhovory)"}

ÚKOLY PRO ${therapistDisplay.toUpperCase()}:
${taskList || "(žádné)"}

PROFIL TERAPEUTKY (INTERNÍ):
${tMemory || "(nedostupný)"}

POSLEDNÍ REPORTY:
${cycleSummaries || "(žádné)"}

ODBORNÉ ZDROJE Z INTERNETU:
${perplexity || "(nedostupné)"}`;

    // Stream via Lovable AI
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
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
