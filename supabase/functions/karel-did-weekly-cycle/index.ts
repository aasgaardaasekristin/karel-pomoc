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

async function listFilesInFolder(token: string, folderId: string): Promise<{ id: string; name: string }[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files || [];
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
  // Find existing
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchRes.json();
  const existingId = searchData.files?.[0]?.id;

  const boundary = "----DIDWeeklyCycleBoundary";
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
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Create weekly cycle record
    const { data: cycle } = await sb
      .from("did_update_cycles")
      .insert({ cycle_type: "weekly", status: "running" })
      .select()
      .single();

    // 1. READ ALL CARDS FROM DRIVE
    let allCardsContent = "";
    let partsList = "";
    let systemMap = "";
    const cardNames: string[] = [];

    try {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");

      if (folderId) {
        const files = await listFilesInFolder(token, folderId);

        for (const file of files) {
          try {
            const content = await readFileContent(token, file.id);
            if (file.name.startsWith("Karta_")) {
              allCardsContent += `\n\n=== ${file.name} ===\n${content}`;
              cardNames.push(file.name.replace("Karta_", "").replace(".txt", "").replace(/_/g, " "));
            } else if (file.name.includes("Seznam_casti")) {
              partsList = content;
            } else if (file.name.includes("Hlavni_mapa")) {
              systemMap = content;
            }
          } catch (e) {
            console.warn(`Failed to read ${file.name}:`, e);
          }
        }
      }
    } catch (e) {
      console.error("Drive read error:", e);
    }

    // 2. GET WEEKLY ACTIVITY DATA FROM DB
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { data: weekThreads } = await sb
      .from("did_threads")
      .select("part_name, sub_mode, started_at, last_activity_at, messages")
      .gte("started_at", weekAgo);

    const { data: weekCycles } = await sb
      .from("did_update_cycles")
      .select("cycle_type, completed_at, report_summary, cards_updated")
      .eq("status", "completed")
      .gte("completed_at", weekAgo)
      .order("completed_at", { ascending: true });

    // Build activity summary
    const activityByPart = new Map<string, { count: number; lastSeen: string; modes: Set<string> }>();
    for (const t of weekThreads || []) {
      const existing = activityByPart.get(t.part_name) || { count: 0, lastSeen: "", modes: new Set() };
      existing.count += ((t.messages as any[]) || []).length;
      existing.modes.add(t.sub_mode);
      if (!existing.lastSeen || t.last_activity_at > existing.lastSeen) existing.lastSeen = t.last_activity_at;
      activityByPart.set(t.part_name, existing);
    }

    const activitySummary = Array.from(activityByPart.entries())
      .map(([name, data]) => `- ${name}: ${data.count} zpráv, režimy: ${Array.from(data.modes).join(", ")}, poslední: ${data.lastSeen}`)
      .join("\n");

    const dailyReportsSummary = (weekCycles || [])
      .filter(c => c.cycle_type === "daily")
      .map(c => `[${c.completed_at}] Karty: ${JSON.stringify(c.cards_updated)}\n${(c.report_summary || "").slice(0, 300)}`)
      .join("\n---\n");

    // 3. AI WEEKLY ANALYSIS
    const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – strategický analytik DID systému. Provádíš TÝDENNÍ ANALÝZU.

Tvůj úkol je trojí:

## 1. TÝDENNÍ REPORT (pro email)
Shrň celý týden:
- Celková aktivita systému (které části byly aktivní, kolikrát)
- Klíčové momenty a pokroky
- Vzorce a trendy (opakující se témata, nálady, dynamiky)
- ⚠️ NEAKTIVNÍ ČÁSTI (7+ dní bez kontaktu) – seznam a doporučení
- Doporučení pro příští týden (konkrétní aktivity, sezení)
- Rizika a varování

## 2. AKTUALIZACE DLOUHODOBÝCH SEKCÍ KARET
Pro každou kartu aktualizuj:
- Sekce H (historie/vzorce): Nové pozorované vzorce chování, opakující se témata
- Sekce I (inter-part vztahy): Změny ve vztazích mezi částmi, nové dynamiky
- Sekce M (dlouhodobé cíle): Přehodnocení a aktualizace na základě týdenního pokroku

Formát:
[KARTA_TYDNI: jméno_části]
Sekce H: ...
Sekce I: ...
Sekce M: ...

## 3. AKTUALIZACE MAPY SYSTÉMU
Pokud se změnily vztahy mezi částmi, navrhni aktualizaci souboru 01_Hlavni_mapa_systemu.

PRAVIDLA:
- NIKDY nesmaž – pouze přidávej s datem
- Zaznamenej zdroj (denní reporty, přímé rozhovory)
- Buď konkrétní a specifický, ne obecný`,
          },
          {
            role: "user",
            content: `AKTUÁLNÍ KARTY:\n${allCardsContent}\n\nSEZNAM ČÁSTÍ:\n${partsList}\n\nMAPA SYSTÉMU:\n${systemMap}\n\nAKTIVITA ZA TÝDEN:\n${activitySummary || "Žádná aktivita"}\n\nDENNÍ REPORTY:\n${dailyReportsSummary || "Žádné denní reporty"}`,
          },
        ],
      }),
    });

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
    }

    // 4. UPDATE CARDS ON DRIVE (sections H, I, M)
    const cardsUpdated: string[] = [];
    try {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");

      if (folderId && analysisText) {
        const dateStr = new Date().toISOString().slice(0, 10);

        // Save weekly report
        await uploadOrUpdate(token, `DID_Tydenni_Report_${dateStr}.txt`, analysisText, folderId);
        cardsUpdated.push("DID_Tydenni_Report");

        // Parse and update individual cards
        const cardMatches = analysisText.matchAll(/\[KARTA_TYDNI:\s*(.+?)\]/g);
        for (const match of cardMatches) {
          const partName = match[1].trim();
          const cardFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;

          // Read existing
          const files = await listFilesInFolder(token, folderId);
          const existingFile = files.find(f => f.name === cardFileName);
          let existingContent = "";
          if (existingFile) {
            existingContent = await readFileContent(token, existingFile.id);
          }

          // Extract weekly update
          const cardStart = analysisText.indexOf(match[0]);
          const nextCard = analysisText.indexOf("[KARTA_TYDNI:", cardStart + 1);
          const cardContent = analysisText.slice(cardStart, nextCard > -1 ? nextCard : undefined);

          const newContent = existingContent
            ? `${existingContent}\n\n=== TÝDENNÍ AKTUALIZACE ${dateStr} (zdroj: týdenní cyklus) ===\n${cardContent}`
            : `=== KARTA ČÁSTI: ${partName} ===\nVytvořeno: ${dateStr}\n\n${cardContent}`;

          await uploadOrUpdate(token, cardFileName, newContent, folderId);
          cardsUpdated.push(partName);
        }

        // Update system map if suggested
        if (analysisText.includes("AKTUALIZACE MAPY") || analysisText.includes("01_Hlavni_mapa")) {
          const mapSection = analysisText.match(/(?:AKTUALIZACE MAPY|MAPA SYSTÉMU)[:\s]*\n([\s\S]*?)(?=\n##|\n\[KARTA|$)/i);
          if (mapSection && systemMap) {
            const updatedMap = `${systemMap}\n\n=== TÝDENNÍ AKTUALIZACE ${dateStr} ===\n${mapSection[1].trim()}`;
            await uploadOrUpdate(token, "01_Hlavni_mapa_systemu.txt", updatedMap, folderId);
            cardsUpdated.push("01_Hlavni_mapa_systemu");
          }
        }
      }
    } catch (e) {
      console.error("Drive update error:", e);
    }

    // 5. SEND WEEKLY EMAIL
    if (RESEND_API_KEY && analysisText) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const dateStr = new Date().toLocaleDateString("cs-CZ");

        let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${analysisText}</pre>`;

        try {
          const fmtRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: "Přeformátuj do čistého HTML emailu s h2, p, ul, li, strong, hr. Použij barvy: zelená pro pokroky, oranžová pro varování, červená pro rizika. Vrať POUZE HTML." },
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

        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [MAMKA_EMAIL],
          subject: `Karel – TÝDENNÍ report DID systému ${dateStr}`,
          html: htmlContent,
        });

        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [KATA_EMAIL],
          subject: `Karel – Týdenní report DID ${dateStr}`,
          html: htmlContent,
        });

        console.log(`Weekly reports sent to ${MAMKA_EMAIL} and ${KATA_EMAIL}`);
      } catch (e) {
        console.error("Email send error:", e);
      }
    }

    // 6.5 TRIGGER RESEARCH WEEKLY SYNC
    let researchSyncResult = null;
    try {
      const researchRes = await fetch(`${supabaseUrl}/functions/v1/karel-research-weekly-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (researchRes.ok) {
        researchSyncResult = await researchRes.json();
        console.log("Research weekly sync completed:", researchSyncResult);
      } else {
        console.warn("Research weekly sync failed:", researchRes.status);
      }
    } catch (e) {
      console.error("Research weekly sync error:", e);
    }

    // 7. UPDATE CYCLE RECORD
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
      cardsAnalyzed: cardNames.length,
      cardsUpdated,
      reportSent: !!RESEND_API_KEY,
      researchSync: researchSyncResult,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Weekly cycle error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
