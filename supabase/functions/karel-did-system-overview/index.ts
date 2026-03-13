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

  const params = new URLSearchParams({
    q,
    fields: "files(id)",
    pageSize: "20",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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

    // 1. Read 00_CENTRUM docs from Google Drive
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

    // 2. Recent threads – split by timeframe
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Last 24h threads (for daily focus)
    const { data: last24hThreads } = await sb
      .from("did_threads")
      .select("part_name, sub_mode, last_activity_at, messages, is_processed")
      .gte("last_activity_at", twentyFourHoursAgo)
      .order("last_activity_at", { ascending: false })
      .limit(30);

    // Last 7 days threads (for weekly context)
    const { data: recentThreads } = await sb
      .from("did_threads")
      .select("part_name, sub_mode, last_activity_at, messages, is_processed")
      .gte("last_activity_at", sevenDaysAgo)
      .order("last_activity_at", { ascending: false })
      .limit(30);

    // Build thread summaries separated by type AND timeframe
    let threadSummary24h = "";
    let therapistSummary24h = "";
    let threadSummaryWeek = "";
    let therapistSummaryWeek = "";
    
    const formatThreadEntry = (t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${(m.content || "").slice(0, 200)}`).join("\n");
      return `\n--- ${t.part_name} [${t.sub_mode}] (${t.last_activity_at}, ${t.is_processed ? "zpracováno" : "nezpracováno"}) ---\n${lastMsgs}\n`;
    };

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

    // 2b. Read cards of active parts from Drive (01_AKTIVNI_FRAGMENTY)
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

    // 3. Last update cycles – ONLY timestamps, NO content (cards_updated/report_summary may contain stale data)
    const { data: cycles } = await sb
      .from("did_update_cycles")
      .select("completed_at, cycle_type")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(3);

    let cycleInfo = "";
    if (cycles) {
      for (const c of cycles) {
        cycleInfo += `\n[${c.cycle_type} cyklus – dokončen ${c.completed_at}]\n`;
      }
    }

    // 4. Get active part names for Perplexity search (already computed above)
    let perplexityTips = "";
    if (PERPLEXITY_API_KEY && activePartNames.length > 0) {
      try {
        const searchQuery = `terapeutické přístupy pro práci s dětskými částmi DID (disociativní porucha identity): ${activePartNames.slice(0, 5).join(", ")}. Stabilizační techniky, hrová terapie, senzomotorické přístupy, IFS, EMDR pro děti. Konkrétní aktivity a hry pro regulaci emocí u disociativních dětí.`;
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

    // 6. Synthesize with Lovable AI (streaming)
    const now = new Date();
    const dayNames = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    const dayAdjs = ["nedělní", "pondělní", "úterní", "středeční", "čtvrteční", "páteční", "sobotní"];
    const dayName = dayNames[now.getDay()];
    const dayAdj = dayAdjs[now.getDay()];
    const hour = now.getHours();
    const minute = now.getMinutes().toString().padStart(2, "0");
    const formattedDate = `${dayName} ${now.getDate()}. ${now.toLocaleDateString("cs-CZ", { month: "long", year: "numeric" })}, ${hour}:${minute}`;
    
    // Rotating greeting variants with correct Czech adjective forms
    const greetingVariants = [
      `Krásné ${dayAdj} ráno (${formattedDate}), Hani a Káťo!`,
      `Zdravím vás v tento ${dayAdj} den (${formattedDate}), milé kolegyně!`,
      `Dobrý den, Hani a Káťo! Je ${formattedDate} a Karel má pro vás čerstvý přehled.`,
      `Tak co, Hani a Káťo – pojďme se podívat, co se děje! Dnes je ${formattedDate}.`,
      `Ahoj, Hani a Káťo! ${formattedDate} – čas na Karlův pohled na věc.`,
      `Vítám vás, Hani a Káťo, v dnešním přehledu (${formattedDate})!`,
      `Hani, Káťo – ${formattedDate}, Karel hlásí stav na palubě.`,
    ];
    // Pick variant based on day-of-year + hour so it rotates naturally
    const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
    const variantIndex = (dayOfYear + hour) % greetingVariants.length;
    const chosenGreeting = greetingVariants[variantIndex];
    
    const synthesisPrompt = `Jsi Karel – supervizní partner a tandem-terapeut. Sestav přehled jako souvislý, osobní, čtivý text pro terapeutky (Hani a Káťu). Dnešní datum a čas: ${formattedDate}.

VSTUPNÍ DATA:

DOKUMENTY Z KARTOTÉKY (00_CENTRUM) – toto je PRIMÁRNÍ ZDROJ PRAVDY:
${centrumDocs || "(nepodařilo se načíst)"}

=== POSLEDNÍCH 24 HODIN ===

VLÁKNA ZA POSLEDNÍCH 24h – ROZHOVORY ČÁSTÍ S KARLEM:
${threadSummary24h || "(žádná vlákna za posledních 24 hodin)"}

VLÁKNA ZA POSLEDNÍCH 24h – ROZHOVORY TERAPEUTEK S KARLEM (Hanička=mamka, Káťa=kata):
${therapistSummary24h || "(žádné rozhovory terapeutek za posledních 24 hodin)"}

=== KONTEXT POSLEDNÍHO TÝDNE (pro širší přehled) ===

VLÁKNA Z POSLEDNÍHO TÝDNE – ROZHOVORY ČÁSTÍ:
${threadSummaryWeek || "(žádná vlákna za poslední týden)"}

VLÁKNA Z POSLEDNÍHO TÝDNE – ROZHOVORY TERAPEUTEK:
${therapistSummaryWeek || "(žádné rozhovory terapeutek za poslední týden)"}

KARTY AKTIVNÍCH ČÁSTÍ (detaily z kartotéky – sekce A-M):
${activePartCards || "(nepodařilo se načíst nebo žádné aktivní části)"}

POSLEDNÍ AKTUALIZACE KARTOTÉKY (pouze metadata – kdy a co bylo aktualizováno):
${cycleInfo || "(žádné záznamy)"}

TERAPEUTICKÉ TIPY Z ODBORNÝCH ZDROJŮ:
${perplexityTips || "(nedostupné)"}

FORMÁT VÝSTUPU:

Začni PŘESNĚ tímto pozdravem (nepřepisuj, neupravuj, použij doslova): "${chosenGreeting}"
Pak rovnou napiš "Zde jsem připravil přehled, co se odehrává s klukama momentálně:" a přejdi k věci. NIKDY nepoužívej jiné datum než to v pozdravu.

NEPOPISUJ obecné základy o DID, terapeutky to ví. NEPOPISUJ co jsou části, jak funguje systém obecně, co je ANP/EP/Host. Piš POUZE o tom co se DĚJE TEĎ a co je relevantní.

Struktura (jako plynulý souvislý text, ne odrážky):

1. **Systémové problémy a aktuální stav** – Začni tím co je kritické a systémové (spánek, medikace, sebepoškozování – jen pokud relevantní). Pak kdo je aktivní, kdo se střídá v těle, jaká je dynamika. Které části umlkly. Je někdo destabilizovaný? Použij data z karet aktivních částí pro hlubší kontext.

2. **Co se dělo posledních 24 hodin** – Kdo s Karlem mluvil DNES/VČERA? Jaký byl jejich stav? Co řešili? Jak to Karel hodnotí? Piš konkrétně – cituj z rozhovorů pokud jsou k dispozici. ZAHRŇ i co řešily terapeutky (Hanička a Káťa) s Karlem – jejich obavy, postřehy, otázky. Rozlišuj jasně 24h vs. starší data.

3. **Kdo potřebuje pozornost** – Které části vyžadují péči? Je potřeba krizová intervence? Je to pro Káťu nebo Hani nebo tandem? Karel VYZVE konkrétní terapeutku ať se mu ozve v jejím podrežimu pro detailnější probrání. Využij informace z karet částí (diagnózy, triggery, terapeutické poznámky).

4. **Terapeutická doporučení** – Konkrétní tipy na aktivity, hry, techniky s aktivními částmi. Použij zdroje z Perplexity pokud jsou dostupné, zakomponuj přirozeně s odkazem. Navrhuj s ohledem na specifika konkrétních částí (věk, role, stav) z jejich karet. Pokud najdeš v kartotéce konkrétní problémy, dohledej a navrhni řešení.

5. **Poslední aktualizace kartotéky** – Kdy proběhla, co se změnilo.

6. **📋 Úkoly pro DNES a ZÍTRA** – Na základě dat z posledních 24h + karet + kartotéky sestav KONKRÉTNÍ denní úkoly:
   - **Hanička – DNES**: Co konkrétně má dnes udělat? S kým promluvit? Jakou techniku vyzkoušet?
   - **Hanička – ZÍTRA**: Co připravit, koho oslovit?
   - **Káťa – DNES**: Co konkrétně má dnes udělat? Na co se zaměřit?
   - **Káťa – ZÍTRA**: Co připravit?
   - **Společné**: Co mají řešit jako tandem?
   Vysvětli každé z nich PROČ – jaká je její role v daném úkolu. Úkoly formuluj jako jasné, akční body (ne obecné rady).
   ⚠️ Tyto úkoly se také automaticky zapíší do seznamu úkolů v aplikaci.

7. **📋 Úkoly pro tento týden** – Širší týdenní úkoly pro každou terapeutku zvlášť:
   - **Hanička**: Týdenní cíle a zaměření
   - **Káťa**: Týdenní cíle a zaměření  
   - **Společné**: Koordinace tandemu

PRAVIDLA:
- Piš česky, osobním tónem, jako by Karel mluvil k Hani a Kátě které zná a má rád
- Nepoužívej dekorativní oddělovače
- Nadpisy jako markdown (## a ###)
- NIKDY nevymýšlej informace – piš jen co je v datech
- NEPIŠ obecné poučky o DID které terapeutky znají
- Pokud máš data z karet částí, VYUŽIJ JE pro konkrétní doporučení (ne obecná)
- Pokud terapeutky s Karlem řešily něco důležitého, ZDŮRAZNI TO
- Pokud v kartotéce najdeš problémy nebo překážky, AKTIVNĚ navrhni řešení z odborných zdrojů`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi Karel, supervizní terapeut. Odpovídej v češtině." },
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
