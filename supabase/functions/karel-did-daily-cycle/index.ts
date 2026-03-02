import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
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
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return await exportRes.text();
  }
  return await res.text();
}

async function uploadOrUpdate(token: string, fileName: string, content: string, folderId: string) {
  const existingId = await findFile(token, fileName, folderId);
  const boundary = "----DIDCycleBoundary";
  const metadata = JSON.stringify(existingId ? { name: fileName } : { name: fileName, parents: [folderId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${await res.text()}`);
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
    
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. SBĚR DAT - Get all unprocessed threads from last 24h
    const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h buffer
    const { data: threads } = await sb
      .from("did_threads")
      .select("*")
      .eq("is_processed", false)
      .gte("started_at", cutoff);

    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No threads to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create cycle record
    const { data: cycle } = await sb
      .from("did_update_cycles")
      .insert({ cycle_type: "daily", status: "running" })
      .select()
      .single();

    // 2. ANALÝZA - Compile all thread data for AI analysis
    const threadSummaries = threads.map(t => {
      const msgs = (t.messages as any[]) || [];
      return `=== Vlákno: ${t.part_name} (${t.sub_mode}) ===\nJazyk: ${t.part_language}\nZačátek: ${t.started_at}\nPoslední aktivita: ${t.last_activity_at}\nPočet zpráv: ${msgs.length}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? "ČÁST/UŽIVATEL" : "KAREL"}]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    // Get Drive context
    let driveContext = "";
    try {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
      if (folderId) {
        // Read parts list
        const partsFileId = await findFile(token, "00_Seznam_casti.txt", folderId);
        if (partsFileId) {
          driveContext = await readFileContent(token, partsFileId);
        }
      }
    } catch (e) {
      console.error("Drive read error:", e);
    }

    // 3. AI ANALÝZA
    const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – analytik DID systému. Zpracuj data z dnešních rozhovorů a vytvoř:

1. REPORT PRO MAIL (česky, srozumitelný):
   - Co bylo změněno (která karta, která sekce A-M)
   - Proč bylo změněno (zdroj: rozhovor, pozorování)
   - Co z toho plyne pro následující den
   - Konkrétní návrh aktivity nebo sezení pro zítřek
   - Upozornění na neaktivní části (7+ dní)

2. AKTUALIZACE KARET (pro každou aktivní část):
   Formát pro každou kartu:
   [KARTA: jméno_části]
   Sekce J (krátkodobé cíle): ...
   Sekce L (aktivita): ...
   Sekce G (deník): ... (pokud proběhlo sezení)
   Sekce K (výstupy): ... (pokud byla zpětná vazba)
   Sekce E (chronologický log): datum + shrnutí

PRAVIDLA:
- NIKDY nesmaž původní data – pouze přidávej s datem
- Zaznamenej zdroj každé změny
- Přizpůsob jazyk karty jazyku části
- Pokud je část nová, navrhni vytvoření karty

${driveContext ? `\nSOUČASNÝ SEZNAM ČÁSTÍ:\n${driveContext}` : ""}`,
          },
          { role: "user", content: threadSummaries },
        ],
      }),
    });

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
    }

    // 4. AKTUALIZACE KARTOTÉKY NA DRIVE
    const cardsUpdated: string[] = [];
    try {
      const token = await getAccessToken();
      let folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
      
      if (folderId && analysisText) {
        const dateStr = new Date().toISOString().slice(0, 10);
        
        // Save daily report
        await uploadOrUpdate(token, `DID_Denni_Report_${dateStr}.txt`, analysisText, folderId);
        cardsUpdated.push("DID_Denni_Report");

        // Parse and update individual cards from analysis
        const cardMatches = analysisText.matchAll(/\[KARTA:\s*(.+?)\]/g);
        for (const match of cardMatches) {
          const partName = match[1].trim();
          const cardFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
          
          // Find existing card content
          const existingId = await findFile(token, cardFileName, folderId);
          let existingContent = "";
          if (existingId) {
            existingContent = await readFileContent(token, existingId);
          }

          // Extract card update section
          const cardStart = analysisText.indexOf(match[0]);
          const nextCard = analysisText.indexOf("[KARTA:", cardStart + 1);
          const cardContent = analysisText.slice(cardStart, nextCard > -1 ? nextCard : undefined);

          const newContent = existingContent
            ? `${existingContent}\n\n=== AKTUALIZACE ${dateStr} (zdroj: denní cyklus) ===\n${cardContent}`
            : `=== KARTA ČÁSTI: ${partName} ===\nVytvořeno: ${dateStr}\n\n${cardContent}`;

          await uploadOrUpdate(token, cardFileName, newContent, folderId);
          cardsUpdated.push(partName);
        }
      }
    } catch (e) {
      console.error("Drive update error:", e);
    }

    // 5. ODESLÁNÍ REPORTU NA MAIL
    if (RESEND_API_KEY && analysisText) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const dateStr = new Date().toLocaleDateString("cs-CZ");
        
        // Format for email
        let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${analysisText}</pre>`;
        
        // Try AI formatting
        try {
          const fmtRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: "Přeformátuj do čistého HTML emailu. Zachovej obsah, přidej h2, p, ul, li, strong. Vrať POUZE HTML." },
                { role: "user", content: analysisText },
              ],
            }),
          });
          if (fmtRes.ok) {
            const fmtData = await fmtRes.json();
            const formatted = fmtData.choices?.[0]?.message?.content;
            if (formatted) htmlContent = formatted.replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
          }
        } catch {}

        // Send to mamka
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [MAMKA_EMAIL],
          subject: `Karel – Report aktualizace ${dateStr}`,
          html: htmlContent,
        });

        // Send to Káťa (shorter version)
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [KATA_EMAIL],
          subject: `Karel – Denní report DID ${dateStr}`,
          html: htmlContent,
        });

        console.log(`Reports sent to ${MAMKA_EMAIL} and ${KATA_EMAIL}`);
      } catch (e) {
        console.error("Email send error:", e);
      }
    }

    // 6. UVOLNĚNÍ PAMĚTI - Mark threads as processed
    const threadIds = threads.map(t => t.id);
    await sb.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", threadIds);

    // Update cycle record
    if (cycle) {
      await sb.from("did_update_cycles").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000),
        cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
    }

    return new Response(JSON.stringify({
      success: true,
      threadsProcessed: threads.length,
      cardsUpdated,
      reportSent: !!RESEND_API_KEY,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Daily cycle error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
