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

async function findFolders(token: string, name: string, parentId?: string): Promise<Array<{ id: string }>> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "20", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const folders = await findFolders(token, name, parentId);
  return folders[0]?.id || null;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const rootVariants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];
  for (const rootName of rootVariants) {
    const candidates = await findFolders(token, rootName);
    for (const candidate of candidates) {
      const centrumId = await findFolder(token, "00_CENTRUM", candidate.id);
      const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", candidate.id);
      if (centrumId || aktivniId) return candidate.id;
    }
    if (candidates[0]?.id) return candidates[0].id;
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // ── 1. Read 00_CENTRUM docs from Google Drive ──
    let centrumDocs = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await resolveKartotekaRoot(token);
      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          const files = await listFilesInFolder(token, centrumId);
          const importantFiles = files.filter(f =>
            /dashboard|instrukce|plan|mapa|geografie|index/i.test(f.name)
          ).slice(0, 8);
          for (const f of importantFiles) {
            try {
              const content = await readFileContent(token, f.id);
              centrumDocs += `\n[${f.name}]\n${content.slice(0, 3000)}\n`;
            } catch { /* skip unreadable */ }
          }
        }
      }
    } catch (e) {
      console.warn("Drive read failed:", e);
    }

    // ── 2. DB: Registry, Tasks, Threads (parallel) ──
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { data: registry },
      { data: pendingTasks },
      { data: last24hThreads },
      { data: recentThreads },
      { data: cycles },
    ] = await Promise.all([
      sb.from("did_part_registry").select("part_name, display_name, status, role_in_system, cluster, age_estimate, last_seen_at, last_emotional_state, last_emotional_intensity, health_score, known_triggers, known_strengths, total_threads, total_episodes").order("last_seen_at", { ascending: false }),
      sb.from("did_therapist_tasks").select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, category, note").in("status", ["pending", "active", "in_progress"]).order("created_at", { ascending: false }).limit(30),
      sb.from("did_threads").select("part_name, sub_mode, last_activity_at, messages, is_processed").gte("last_activity_at", twentyFourHoursAgo).order("last_activity_at", { ascending: false }).limit(30),
      sb.from("did_threads").select("part_name, sub_mode, last_activity_at, messages, is_processed").gte("last_activity_at", sevenDaysAgo).order("last_activity_at", { ascending: false }).limit(30),
      sb.from("did_update_cycles").select("completed_at, cycle_type").eq("status", "completed").order("completed_at", { ascending: false }).limit(3),
    ]);

    // ── 2a. Format registry as structured data ──
    let registryBlock = "";
    if (registry && registry.length > 0) {
      for (const r of registry) {
        registryBlock += `\n[REGISTR: ${r.display_name || r.part_name}]`;
        registryBlock += `\n  Status: ${r.status}`;
        if (r.role_in_system) registryBlock += ` | Role: ${r.role_in_system}`;
        if (r.cluster) registryBlock += ` | Klastr: ${r.cluster}`;
        if (r.age_estimate) registryBlock += ` | Věk: ${r.age_estimate}`;
        if (r.last_seen_at) registryBlock += `\n  Naposledy viděn: ${r.last_seen_at}`;
        if (r.last_emotional_state) registryBlock += ` | Emoce: ${r.last_emotional_state} (${r.last_emotional_intensity ?? "?"}/ 10)`;
        if (r.health_score != null) registryBlock += ` | Zdraví karty: ${r.health_score}%`;
        if (r.known_triggers?.length) registryBlock += `\n  Triggery: ${r.known_triggers.join(", ")}`;
        if (r.known_strengths?.length) registryBlock += `\n  Silné stránky: ${r.known_strengths.join(", ")}`;
        registryBlock += `\n  Vlákna: ${r.total_threads ?? 0} | Epizody: ${r.total_episodes ?? 0}`;
        registryBlock += "\n";
      }
    }

    // ── 2b. Format tasks ──
    let tasksBlock = "";
    if (pendingTasks && pendingTasks.length > 0) {
      for (const t of pendingTasks) {
        tasksBlock += `\n- [${t.priority || "normal"}] ${t.task} → ${t.assigned_to} (H:${t.status_hanka}, K:${t.status_kata})`;
        if (t.due_date) tasksBlock += ` do ${t.due_date}`;
        if (t.note) tasksBlock += ` // ${t.note.slice(0, 100)}`;
      }
    }

    // ── 2c. Format threads ──
    const formatThreadEntry = (t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const userRole = t.sub_mode === "cast" ? "ČÁST" : "TERAPEUT";
      const userMsgs = msgs
        .filter((m: any) => m?.role === "user" && typeof m?.content === "string")
        .slice(-6)
        .map((m: any) => `[${userRole}] ${(m.content || "").slice(0, 260)}`)
        .join("\n");
      return `\n--- ${t.part_name} [${t.sub_mode}] (${t.last_activity_at}, ${t.is_processed ? "zpracováno" : "nezpracováno"}) ---\n${userMsgs || "(bez user zpráv)"}\n`;
    };

    let threadSummary24h = "";
    let therapistSummary24h = "";
    let threadSummaryWeek = "";
    let therapistSummaryWeek = "";

    if (last24hThreads) {
      for (const t of last24hThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummary24h += entry;
        } else {
          threadSummary24h += entry;
        }
      }
    }
    if (recentThreads) {
      for (const t of recentThreads) {
        const entry = formatThreadEntry(t);
        if (t.sub_mode === "mamka" || t.sub_mode === "kata") {
          therapistSummaryWeek += entry;
        } else {
          threadSummaryWeek += entry;
        }
      }
    }

    // ── 2d. Read cards of active parts from Drive ──
    let activePartCards = "";
    const activePartNames = recentThreads
      ? [...new Set(recentThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))]
      : [];
    if (activePartNames.length > 0) {
      try {
        const token = await getAccessToken();
        const kartotekaId = await resolveKartotekaRoot(token);
        if (kartotekaId) {
          const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", kartotekaId);
          if (aktivniId) {
            const partFiles = await listFilesInFolder(token, aktivniId);
            for (const partName of activePartNames.slice(0, 6)) {
              const normalizedName = partName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
              const matchedFile = partFiles.find(f => {
                const fn = f.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                return fn.includes(normalizedName);
              });
              if (matchedFile) {
                try {
                  const content = await readFileContent(token, matchedFile.id);
                  activePartCards += `\n[KARTA: ${matchedFile.name}]\n${content.slice(0, 4000)}\n`;
                } catch { /* skip */ }
              }
            }
          }
        }
      } catch (e) {
        console.warn("Active part cards read failed:", e);
      }
    }

    // ── 2e. Cycles metadata ──
    let cycleInfo = "";
    if (cycles) {
      for (const c of cycles) {
        cycleInfo += `\n[${c.cycle_type} cyklus – dokončen ${c.completed_at}]\n`;
      }
    }

    // ── 3. Optional Perplexity tips ──
    let perplexityTips = "";
    if (PERPLEXITY_API_KEY && activePartNames.length > 0) {
      try {
        const searchQuery = `terapeutické přístupy pro práci s dětskými částmi DID (disociativní porucha identity): ${activePartNames.slice(0, 5).join(", ")}. Stabilizační techniky, hrová terapie, senzomotorické přístupy, IFS, EMDR pro děti.`;
        const pxRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar-pro",
            messages: [
              { role: "system", content: "Jsi odborný výzkumník. Vrať 3-5 konkrétních terapeutických tipů/technik s krátkým popisem a zdrojem. Odpověz v češtině. Max 500 slov." },
              { role: "user", content: searchQuery },
            ],
            search_recency_filter: "year",
          }),
        });
        if (pxRes.ok) {
          const pxData = await pxRes.json();
          perplexityTips = pxData.choices?.[0]?.message?.content || "";
          const citations = pxData.citations || [];
          if (citations.length > 0) {
            perplexityTips += "\n\nZdroje:\n" + citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
          }
        }
      } catch (e) {
        console.warn("Perplexity search failed:", e);
      }
    }

    // ── 4. Build greeting ──
    const now = new Date();
    const dayNames = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    const dayAdjs = ["nedělní", "pondělní", "úterní", "středeční", "čtvrteční", "páteční", "sobotní"];
    const dayName = dayNames[now.getDay()];
    const dayAdj = dayAdjs[now.getDay()];
    const hour = now.getHours();
    const minute = now.getMinutes().toString().padStart(2, "0");
    const formattedDate = `${dayName} ${now.getDate()}. ${now.toLocaleDateString("cs-CZ", { month: "long", year: "numeric" })}, ${hour}:${minute}`;

    const greetingVariants = [
      `Krásné ${dayAdj} ráno (${formattedDate}), Hani a Káťo!`,
      `Zdravím vás v tento ${dayAdj} den (${formattedDate}), milé kolegyně!`,
      `Dobrý den, Hani a Káťo! Je ${formattedDate} a Karel má pro vás čerstvý přehled.`,
      `Tak co, Hani a Káťo – pojďme se podívat, co se děje! Dnes je ${formattedDate}.`,
      `Ahoj, Hani a Káťo! ${formattedDate} – čas na Karlův pohled na věc.`,
      `Vítám vás, Hani a Káťo, v dnešním přehledu (${formattedDate})!`,
      `Hani, Káťo – ${formattedDate}, Karel hlásí stav na palubě.`,
    ];
    const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
    const variantIndex = (dayOfYear + hour) % greetingVariants.length;
    const chosenGreeting = greetingVariants[variantIndex];

    // ── 5. STRICT synthesis prompt ──
    const synthesisPrompt = `Jsi Karel – supervizní partner a tandem-terapeut. Sestav přehled VÝHRADNĚ z přiložených dat.

⚠️ ABSOLUTNÍ ZÁKAZY – PORUŠENÍ = SELHÁNÍ:
1. NIKDY NEVYMÝŠLEJ informace, čísla, skóre, stavy ani hodnocení které NEJSOU DOSLOVA v datech.
2. NIKDY nepiš "stabilita X/10" pokud toto číslo NENÍ v registru nebo v citovaném textu.
3. NIKDY nepiš "akutní destabilizace", "kritický bod", "dekompenzace" pokud to DOSLOVA neřekla část nebo terapeutka v rozhovoru.
4. NIKDY nepřidávej dramatizaci. Pokud data říkají "unavený", nepiš "akutní vyčerpání s rizikem kolapsu".
5. Pokud pro nějakou část NEMÁŠ data z posledních 24h, napiš "nemám aktuální data" – NEVYMÝŠLEJ stav.
6. NEPOUŽÍVEJ obecné poučky o DID – terapeutky to znají.

FORMÁT CITACÍ:
Ke každému tvrzení o stavu/emoci/události MUSÍŠ přidat odkaz na zdroj:
- [REG] = z registru částí
- [VLÁKNO:jméno] = z konverzačního vlákna
- [KARTA:jméno] = z karty části
- [DRIVE:název_souboru] = z dokumentu na Drive
- [ÚKOL] = z úkolů terapeutek
Tvrzení BEZ citace = halucinace = zakázáno.

VSTUPNÍ DATA:

=== REGISTR ČÁSTÍ (databáze – autoritativní zdroj stavů) ===
${registryBlock || "(registr je prázdný)"}

=== AKTIVNÍ ÚKOLY TERAPEUTEK ===
${tasksBlock || "(žádné aktivní úkoly)"}

=== DOKUMENTY Z KARTOTÉKY (00_CENTRUM) ===
${centrumDocs || "(nepodařilo se načíst)"}

=== POSLEDNÍCH 24 HODIN – ROZHOVORY ČÁSTÍ ===
${threadSummary24h || "(žádná vlákna za posledních 24 hodin)"}

=== POSLEDNÍCH 24 HODIN – ROZHOVORY TERAPEUTEK ===
${therapistSummary24h || "(žádné rozhovory terapeutek za posledních 24 hodin)"}

=== KONTEXT POSLEDNÍHO TÝDNE – ROZHOVORY ČÁSTÍ ===
${threadSummaryWeek || "(žádná vlákna za poslední týden)"}

=== KONTEXT POSLEDNÍHO TÝDNE – ROZHOVORY TERAPEUTEK ===
${therapistSummaryWeek || "(žádné rozhovory terapeutek za poslední týden)"}

=== KARTY AKTIVNÍCH ČÁSTÍ (detaily z kartotéky) ===
${activePartCards || "(nepodařilo se načíst nebo žádné aktivní části)"}

=== POSLEDNÍ AKTUALIZACE KARTOTÉKY ===
${cycleInfo || "(žádné záznamy)"}

=== TERAPEUTICKÉ TIPY Z ODBORNÝCH ZDROJŮ ===
${perplexityTips || "(nedostupné)"}

FORMÁT VÝSTUPU:

Začni PŘESNĚ tímto pozdravem (nepřepisuj): "${chosenGreeting}"
Pak: "Zde je přehled založený na aktuálních datech:"

Struktura (jako plynulý text, nadpisy ## a ###):

1. **Stav systému podle registru** – Pro KAŽDOU část v registru uveď: jméno, status, poslední emoce (pokud je), zdraví karty. Cituj [REG]. Pokud část nemá data z posledních 24h, řekni to explicitně. NEDOMÝŠLEJ co dělá nebo jak se cítí.

2. **Co se dělo posledních 24 hodin** – POUZE pokud existují vlákna. Cituj DOSLOVA z rozhovorů. Uveď KDO mluvil, CO řekl (krátká citace). Cituj [VLÁKNO:jméno]. Pokud žádná vlákna nejsou, napiš "Za posledních 24 hodin neproběhly žádné rozhovory."

3. **Rozhovory terapeutek** – Co řešily Hanka a Káťa s Karlem? Cituj [VLÁKNO:mamka/kata]. Pokud nic, řekni to.

4. **Kdo potřebuje pozornost** – POUZE na základě dat z registru + vláken. Pokud má část emoční intenzitu ≥7 [REG] nebo pokud v rozhovoru zaznělo něco alarmujícího [VLÁKNO], uveď to. NEVYMÝŠLEJ krizové stavy.

5. **Aktivní úkoly** – Vypiš úkoly z databáze [ÚKOL]. Kdo má co udělat, jaký je stav.

6. **Terapeutická doporučení** – POUZE pokud máš tipy z Perplexity. Zakomponuj s citací zdroje. Pokud ne, vynech celou sekci.

7. **Poslední aktualizace kartotéky** – Kdy proběhla.

8. **📋 Návrhy úkolů** – Na základě DAT (ne domněnek) navrhni konkrétní akční body pro Hanu a Káťu. Každý úkol musí mít citaci zdroje PROČ ho navrhuješ.

PRAVIDLA:
- Piš česky, osobním tónem, ale STRIKTNĚ fakticky
- Nepoužívej dekorativní oddělovače
- Nadpisy jako markdown (## a ###)
- Každé tvrzení MUSÍ mít [REG], [VLÁKNO:x], [KARTA:x], [DRIVE:x] nebo [ÚKOL] citaci
- Pokud nemáš data, řekni "nemám data" – NEVYMÝŠLEJ
- ŽÁDNÉ vymyšlené skóre stability, ŽÁDNÉ dramatizace`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi Karel, supervizní terapeut. STRIKTNĚ dodržuj formát citací. NIKDY nevymýšlej data která nejsou ve vstupech. Odpovídej v češtině." },
          { role: "user", content: synthesisPrompt },
        ],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit – zkus to za chvilku." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Nedostatek kreditů." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errText);
      throw new Error("AI gateway error");
    }

    return new Response(aiResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("System overview error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
