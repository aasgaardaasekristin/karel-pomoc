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
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFile(token: string, name: string, parentId: string): Promise<{ id: string; name: string } | null> {
  const q = `name contains '${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function readGoogleDoc(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Cannot read doc ${fileId}: ${res.status}`);
  return await res.text();
}

async function appendToGoogleDoc(token: string, fileId: string, textToAppend: string): Promise<void> {
  // Get current document to find end index
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) throw new Error(`Cannot read doc structure: ${docRes.status}`);
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

  const requests = [
    {
      insertText: {
        location: { index: endIndex - 1 },
        text: "\n\n" + textToAppend,
      },
    },
  ];

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error("Docs API error:", errText);
    throw new Error(`Failed to append to doc: ${updateRes.status}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Allow both user auth and cron key
  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const isCronCall = authHeader === `Bearer ${serviceRoleKey}` || authHeader === `Bearer ${anonKey}`;

  if (!isCronCall) {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. GET ALL RESEARCH THREADS FROM LAST WEEK
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { data: threads, error: threadsError } = await sb
      .from("research_threads")
      .select("*")
      .eq("is_deleted", false)
      .eq("is_processed", false)
      .gte("started_at", weekAgo);

    if (threadsError) throw new Error(`DB error: ${threadsError.message}`);
    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No research threads to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing ${threads.length} research threads`);

    // 2. BUILD THREAD SUMMARIES FOR AI
    const threadSummaries = threads.map((t: any) => {
      const msgs = (t.messages || []) as { role: string; content: string }[];
      const userMsgs = msgs.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content.slice(0, 500) : "").join("\n");
      const assistantMsgs = msgs.filter(m => m.role === "assistant").map(m => typeof m.content === "string" ? m.content.slice(0, 1500) : "").join("\n---\n");
      return `
═══ VLÁKNO: ${t.topic} ═══
Založil/a: ${t.created_by}
Datum: ${t.started_at}
Počet zpráv: ${msgs.length}

DOTAZY UŽIVATELE:
${userMsgs}

ODPOVĚDI KARLA (výzkum):
${assistantMsgs}
`;
    }).join("\n\n");

    // 3. AI SYNTHESIS — Create structured entries for 07_Knihovna
    const synthesisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – supervizní partner a archivář profesních zdrojů pro terapeutky Hanu a Káťu.

Tvým úkolem je zpracovat výzkumná vlákna z posledního týdne a vytvořit strukturované záznamy do dokumentu 07_Knihovna.

PRO KAŽDÉ VLÁKNO vytvoř záznam v tomto formátu:

ZDROJ_[číslo]_[datum YYYY-MM-DD]:
Téma: [název vlákna]
Záznam: Vyhledal/a [jméno]. [Pro jaký účel se to hodí]. [Stručná sumarizace – 2-3 věty]
Podrobný popis: [Detailní popis metody/tématu, použití, návrhy jak a kde to použít]
Karlovy připomínky a úkoly: [Tvé doporučení, jak to začlenit do praxe, co zkusit, u jakého klienta/části]
Zkušenosti terapeutů: [zatím prázdné – terapeuti doplní později]
Karlova dodatečná reakce: [zatím prázdné – Karel doplní při příští aktualizaci]

---

Dále identifikuj informace relevantní pro DID systém a navrhni:
1. [DID_PLAN] Co přidat do 05_Terapeuticky_Plan_Aktualni
2. [DID_DOHODY] Co přidat do 06_Terapeuticke_Dohody
3. [DID_DASHBOARD] Co aktualizovat v 00_Aktualni_Dashboard
4. [DID_KARTA:jméno_části] Co zapsat do karty konkrétní části (pokud je metoda vhodná pro konkrétní část)
5. [UKOL_HANA] Úkol pro Hanu (krátkodobý/dlouhodobý)
6. [UKOL_KATA] Úkol pro Káťu
7. [UKOL_TANDEM] Společný úkol pro oba terapeuty

PRAVIDLA:
- Čísluj ZDROJ_ postupně od posledního čísla v dokumentu (pokud není známé, začni od 1)
- Buď konkrétní a praktický
- NIKDY nevymýšlej citace – použij pouze zdroje z vláken
- Zaměř se na terapeutickou hodnotu informací`,
          },
          {
            role: "user",
            content: `Zpracuj tato výzkumná vlákna z posledního týdne:\n\n${threadSummaries}`,
          },
        ],
      }),
    });

    if (!synthesisResponse.ok) {
      const errText = await synthesisResponse.text();
      console.error("AI synthesis error:", synthesisResponse.status, errText);
      throw new Error(`AI synthesis failed: ${synthesisResponse.status}`);
    }

    const synthesisData = await synthesisResponse.json();
    const synthesisText = synthesisData.choices?.[0]?.message?.content || "";

    if (!synthesisText) {
      return new Response(JSON.stringify({ success: true, message: "AI returned empty synthesis" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. WRITE TO GOOGLE DRIVE — 07_Knihovna
    let knihovnaUpdated = false;
    const didUpdates: string[] = [];

    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
      if (!kartotekaId) throw new Error("Kartoteka_DID folder not found");

      const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
      if (!centrumId) throw new Error("00_CENTRUM folder not found");

      // Find 07_Knihovna document
      const knihovnaFile = await findFile(token, "07_Knihovna", centrumId);
      if (knihovnaFile) {
        // Extract the ZDROJ entries from synthesis (before DID-specific markers)
        const zdrojEntries = synthesisText.split(/\[DID_/)[0].trim();
        if (zdrojEntries) {
          const dateStr = new Date().toISOString().slice(0, 10);
          const header = `\n\n════════════════════════════════════════\nTÝDENNÍ AKTUALIZACE: ${dateStr}\nZpracováno vláken: ${threads.length}\n════════════════════════════════════════\n\n`;
          await appendToGoogleDoc(token, knihovnaFile.id, header + zdrojEntries);
          knihovnaUpdated = true;
          console.log("07_Knihovna updated successfully");
        }
      } else {
        console.warn("07_Knihovna document not found in 00_CENTRUM");
      }

      // 5. PROCESS DID-SPECIFIC UPDATES
      // Update 05_Terapeuticky_Plan_Aktualni
      const planMatch = synthesisText.match(/\[DID_PLAN\]([\s\S]*?)(?=\[DID_|\[UKOL_|$)/);
      if (planMatch && planMatch[1].trim()) {
        const planFile = await findFile(token, "05_Terapeuticky_Plan", centrumId);
        if (planFile) {
          const dateStr = new Date().toISOString().slice(0, 10);
          await appendToGoogleDoc(token, planFile.id, `\n[${dateStr} – z profesních zdrojů]\n${planMatch[1].trim()}`);
          didUpdates.push("05_Terapeuticky_Plan_Aktualni");
        }
      }

      // Update 06_Terapeuticke_Dohody
      const dohodyMatch = synthesisText.match(/\[DID_DOHODY\]([\s\S]*?)(?=\[DID_|\[UKOL_|$)/);
      if (dohodyMatch && dohodyMatch[1].trim()) {
        const dohodyFile = await findFile(token, "06_Terapeuticke_Dohody", centrumId);
        if (dohodyFile) {
          const dateStr = new Date().toISOString().slice(0, 10);
          await appendToGoogleDoc(token, dohodyFile.id, `\n[${dateStr} – z profesních zdrojů]\n${dohodyMatch[1].trim()}`);
          didUpdates.push("06_Terapeuticke_Dohody");
        }
      }

      // Update 00_Aktualni_Dashboard
      const dashMatch = synthesisText.match(/\[DID_DASHBOARD\]([\s\S]*?)(?=\[DID_|\[UKOL_|$)/);
      if (dashMatch && dashMatch[1].trim()) {
        const dashFile = await findFile(token, "00_Aktualni_Dashboard", centrumId) || await findFile(token, "Dashboard", centrumId);
        if (dashFile) {
          const dateStr = new Date().toISOString().slice(0, 10);
          await appendToGoogleDoc(token, dashFile.id, `\n[${dateStr} – Profesní zdroje]\n${dashMatch[1].trim()}`);
          didUpdates.push("00_Aktualni_Dashboard");
        }
      }

      // Update individual part cards
      const partCardMatches = synthesisText.matchAll(/\[DID_KARTA:([^\]]+)\]([\s\S]*?)(?=\[DID_|\[UKOL_|$)/g);
      const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", kartotekaId);
      for (const match of partCardMatches) {
        const partName = match[1].trim();
        const content = match[2].trim();
        if (!content || !aktivniId) continue;
        const partFile = await findFile(token, partName, aktivniId);
        if (partFile) {
          const dateStr = new Date().toISOString().slice(0, 10);
          await appendToGoogleDoc(token, partFile.id, `\n[${dateStr} – z profesních zdrojů]\n${content}`);
          didUpdates.push(`Karta: ${partName}`);
        }
      }
    } catch (e) {
      console.error("Drive update error:", e);
    }

    // 6. MARK THREADS AS PROCESSED
    const threadIds = threads.map((t: any) => t.id);
    await sb
      .from("research_threads")
      .update({ is_processed: true, processed_at: new Date().toISOString() })
      .in("id", threadIds);

    return new Response(JSON.stringify({
      success: true,
      threadsProcessed: threads.length,
      knihovnaUpdated,
      didUpdates,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Research weekly sync error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
