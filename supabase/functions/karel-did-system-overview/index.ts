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

async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
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
      const kartotekaId = await findFolder(token, "Kartoteka_DID");
      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM");
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

    // 2. Recent threads (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentThreads } = await sb
      .from("did_threads")
      .select("part_name, last_activity_at, messages, is_processed")
      .eq("sub_mode", "cast")
      .gte("last_activity_at", sevenDaysAgo)
      .order("last_activity_at", { ascending: false });

    // Build thread summaries
    let threadSummary = "";
    if (recentThreads && recentThreads.length > 0) {
      for (const t of recentThreads) {
        const msgs = Array.isArray(t.messages) ? t.messages : [];
        const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${(m.content || "").slice(0, 200)}`).join("\n");
        threadSummary += `\n--- ${t.part_name} (${t.last_activity_at}, ${t.is_processed ? "zpracováno" : "nezpracováno"}) ---\n${lastMsgs}\n`;
      }
    }

    // 3. Last update cycles (last 3)
    const { data: cycles } = await sb
      .from("did_update_cycles")
      .select("completed_at, report_summary, cards_updated, cycle_type")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(3);

    let cycleInfo = "";
    if (cycles) {
      for (const c of cycles) {
        cycleInfo += `\n[${c.cycle_type} – ${c.completed_at}] ${c.report_summary || "bez reportu"}\nAktualizované karty: ${JSON.stringify(c.cards_updated)}\n`;
      }
    }

    // 4. Get active part names for Perplexity search
    const activePartNames = recentThreads
      ? [...new Set(recentThreads.map(t => t.part_name))]
      : [];

    // 5. Perplexity therapeutic tips (if available)
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
    const synthesisPrompt = `Jsi Karel – supervizní partner a tandem-terapeut. Sestav přehled jako souvislý, osobní, čtivý text pro terapeutky (Hani a Káťu). Dnešní datum: ${now.toLocaleDateString("cs-CZ")}.

VSTUPNÍ DATA:

DOKUMENTY Z KARTOTÉKY (00_CENTRUM):
${centrumDocs || "(nepodařilo se načíst)"}

VLÁKNA Z POSLEDNÍHO TÝDNE (rozhovory částí s Karlem):
${threadSummary || "(žádná vlákna za poslední týden)"}

CYKLY AKTUALIZACE KARTOTÉKY:
${cycleInfo || "(žádné záznamy)"}

TERAPEUTICKÉ TIPY Z ODBORNÝCH ZDROJŮ:
${perplexityTips || "(nedostupné)"}

FORMÁT VÝSTUPU:

Začni neformálním, osobním pozdravem – např. "Krásného [den a datum], Hani a Káťo!" (NIKDY "Vážené", NIKDY formální tón).
Pak rovnou napiš "Zde jsem připravil přehled, co se odehrává s klukama momentálně:" a přejdi k věci.

NEPOPISUJ obecné základy o DID, terapeutky to ví. NEPOPISUJ co jsou části, jak funguje systém obecně, co je ANP/EP/Host. Piš POUZE o tom co se DĚJE TEĎ a co je relevantní.

Struktura (jako plynulý souvislý text, ne odrážky):

1. **Systémové problémy a aktuální stav** – Začni tím co je kritické a systémové (spánek, medikace, sebepoškozování – jen pokud relevantní). Pak kdo je aktivní, kdo se střídá v těle, jaká je dynamika. Které části umlkly. Je někdo destabilizovaný?

2. **Přehled posledního týdne** – Kdo s Karlem mluvil včera/předevčírem? Jaký byl jejich stav? Co řešili? Jak to Karel hodnotí? Piš konkrétně – cituj z rozhovorů pokud jsou k dispozici.

3. **Kdo potřebuje pozornost** – Které části vyžadují péči? Je potřeba krizová intervence? Je to pro Káťu nebo Hani nebo tandem? Karel VYZVE konkrétní terapeutku ať se mu ozve v jejím podrežimu pro detailnější probrání.

4. **Terapeutická doporučení** – Konkrétní tipy na aktivity, hry, techniky s aktivními částmi. Použij zdroje z Perplexity pokud jsou dostupné, zakomponuj přirozeně s odkazem.

5. **Poslední aktualizace kartotéky** – Kdy proběhla, co se změnilo.

PRAVIDLA:
- Piš česky, osobním tónem, jako by Karel mluvil k Hani a Kátě které zná a má rád
- Nepoužívej dekorativní oddělovače
- Nadpisy jako markdown (## a ###)
- NIKDY nevymýšlej informace – piš jen co je v datech
- NEPIŠ obecné poučky o DID které terapeutky znají`;

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
