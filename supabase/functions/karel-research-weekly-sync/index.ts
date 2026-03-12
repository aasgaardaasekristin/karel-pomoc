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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findOrCreateFolder(token: string, name: string, parentId: string): Promise<string | null> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) { console.error(`Failed to create folder ${name}: ${res.status}`); return null; }
  const folder = await res.json();
  return folder.id;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files || [];
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

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----ResearchSyncBoundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return await res.json();
}

// ═══ HANDBOOK JSON → Formatted text for Google Doc ═══
function handbookToFormattedText(handbook: any): string {
  const lines: string[] = [];

  lines.push(`TERAPEUTICKÁ PŘÍRUČKA`);
  lines.push(`Téma: ${handbook.topic || "konzultace"}`);
  lines.push(`Připravil/a: ${handbook.createdBy || "neznámé"}`);
  lines.push(`Datum: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Vygenerováno aplikací Karel – supervizní partner`);
  lines.push("");

  if (handbook.summary) {
    lines.push("SHRNUTÍ");
    lines.push(handbook.summary);
    lines.push("");
  }

  const activities = handbook.activities || [];
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    lines.push(`METODA ${i + 1}: ${a.name || "Bez názvu"}`);
    lines.push("");

    if (a.target_group) lines.push(`Cílová skupina: ${a.target_group}`);
    if (a.goal) lines.push(`Účel/Cíl: ${a.goal}`);
    if (a.principle) lines.push(`Psychologický princip: ${a.principle}`);
    if (a.difficulty) lines.push(`Obtížnost: ${a.difficulty}`);
    if (a.duration) lines.push(`Délka: ${a.duration}`);
    lines.push("");

    if (a.materials && a.materials.length > 0) {
      lines.push("Pomůcky:");
      for (const m of a.materials) lines.push(`  - ${m}`);
      lines.push("");
    }

    if (a.introduction) {
      lines.push("Jak uvést:");
      lines.push(a.introduction);
      lines.push("");
    }

    if (a.steps && a.steps.length > 0) {
      lines.push("Postup krok za krokem:");
      for (const s of a.steps) lines.push(`  ${s}`);
      lines.push("");
    }

    if (a.expected_course) {
      lines.push("Očekávaný průběh:");
      lines.push(a.expected_course);
      lines.push("");
    }

    if (a.expected_outcome) {
      lines.push("Očekávaný výsledek:");
      lines.push(a.expected_outcome);
      lines.push("");
    }

    if (a.diagnostic_watch && a.diagnostic_watch.length > 0) {
      lines.push("Diagnostická pozorování:");
      for (const d of a.diagnostic_watch) lines.push(`  - ${d}`);
      lines.push("");
    }

    if (a.warnings && a.warnings.length > 0) {
      lines.push("⚠️ Upozornění:");
      for (const w of a.warnings) lines.push(`  - ${w}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  if (handbook.general_tips && handbook.general_tips.length > 0) {
    lines.push("OBECNÉ TIPY PRO PRAXI");
    for (const tip of handbook.general_tips) lines.push(`- ${tip}`);
    lines.push("");
  }

  if (handbook.sources && handbook.sources.length > 0) {
    lines.push("ZDROJE");
    for (const src of handbook.sources) {
      let line = `- ${src.title || "Bez názvu"}`;
      if (src.url) line += ` (${src.url})`;
      if (src.description) line += ` – ${src.description}`;
      lines.push(line);
    }
    lines.push("");
  }

  if (handbook.karel_notes) {
    lines.push("KARLOVY POZNÁMKY");
    lines.push(handbook.karel_notes);
    lines.push("");
  }

  return lines.join("\n");
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
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. GET ALL UNPROCESSED RESEARCH THREADS
    const { data: threads, error: threadsError } = await sb
      .from("research_threads")
      .select("*")
      .eq("is_deleted", false)
      .eq("is_processed", false);

    if (threadsError) throw new Error(`DB error: ${threadsError.message}`);
    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No research threads to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processing ${threads.length} research threads`);

    // 2. FIND 07_KNIHOVNA FOLDER
    const token = await getAccessToken();
    const kartotekaId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
    if (!kartotekaId) throw new Error("Kartoteka_DID folder not found");

    const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
    if (!centrumId) throw new Error("00_CENTRUM folder not found");

    let knihovnaFolderId = await findFolder(token, "07_Knihovna", centrumId);
    if (!knihovnaFolderId) {
      knihovnaFolderId = await findOrCreateFolder(token, "07_Knihovna", centrumId);
    }
    if (!knihovnaFolderId) throw new Error("Could not find/create 07_Knihovna");

    // 3. FIND OR CREATE 00_Prehled DOC
    const knihovnaFiles = await listFilesInFolder(token, knihovnaFolderId);
    let prehledFile = knihovnaFiles.find(f => f.name.startsWith("00_Prehled"));
    if (!prehledFile) {
      const created = await createFileInFolder(token, "00_Prehled", "PŘEHLED KNIHOVNY – PROFESNÍ ZDROJE\n\nZde se ukládají stručné přehledy nových zdrojů z Profesních rešerší.\n", knihovnaFolderId);
      prehledFile = { id: created.id, name: "00_Prehled" };
      console.log("[sync] ✅ Created 00_Prehled");
    }

    // 4. FOR EACH THREAD: GENERATE HANDBOOK + SAVE AS DOC
    const savedHandbooks: string[] = [];
    const prehledEntries: string[] = [];
    const dateStr = new Date().toISOString().slice(0, 10);

    for (const thread of threads) {
      const msgs = (thread.messages || []) as { role: string; content: string }[];
      if (msgs.length < 2) {
        console.log(`[sync] Skipping thread "${thread.topic}" – too few messages`);
        continue;
      }

      const normalizedCreatedBy = thread.created_by === "Káťa" ? "Káťa" : (thread.created_by || "Hana");
      const osobniOsloveni = normalizedCreatedBy === "Káťa" ? "Káťo" : "Haničko";

      // 4a. Generate handbook via AI (same logic as karel-research-handbook)
      let handbook: any = null;
      try {
        // Perplexity enrichment
        let perplexityEnrichment = "";
        if (PERPLEXITY_API_KEY) {
          try {
            const pxRes = await fetch("https://api.perplexity.ai/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "sonar-pro",
                messages: [
                  { role: "system", content: "Jsi výzkumný asistent zaměřený na psychoterapii. Hledej odborné články relevantní k zadanému tématu. Odpověz česky." },
                  { role: "user", content: `Najdi odborné zdroje k tématu: "${thread.topic}". Zaměř se na konkrétní terapeutické techniky a evidence-based přístupy.` },
                ],
                search_mode: "academic",
              }),
            });
            if (pxRes.ok) {
              const pxData = await pxRes.json();
              perplexityEnrichment = pxData.choices?.[0]?.message?.content || "";
              const citations = pxData.citations || [];
              if (citations.length > 0) {
                perplexityEnrichment += "\n\nZdroje:\n" + citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
              }
            }
          } catch (e) { console.warn(`[sync] Perplexity enrichment failed for "${thread.topic}":`, e); }
        }

        const conversationText = msgs
          .map((m) => `${m.role === "user" ? normalizedCreatedBy : "Karel"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`)
          .join("\n\n");

        const synthesisPrompt = `Jsi Karel, supervizní AI asistent. Na základě rozhovoru s terapeutem/kou (${normalizedCreatedBy}) vytvoř STRUKTUROVANOU PŘÍRUČKU.

PRAVIDLO OSLOVENÍ: Příručka je pro ${normalizedCreatedBy}. Oslovuj "${osobniOsloveni}". Nepředstavuj se jako "tady Karel".

ROZHOVOR:
${conversationText}

${perplexityEnrichment ? `DOPLŇUJÍCÍ ODBORNÉ INFORMACE:\n${perplexityEnrichment}` : ""}

Vytvoř příručku v JSON formátu:
{
  "topic": "stručný název tématu",
  "createdBy": "${normalizedCreatedBy}",
  "summary": "shrnutí v 3-5 větách",
  "activities": [
    {
      "name": "NÁZEV metody",
      "target_group": "pro koho",
      "goal": "účel",
      "principle": "psychologický princip",
      "materials": ["seznam pomůcek"],
      "introduction": "jak uvést",
      "steps": ["krok 1", "krok 2"],
      "expected_course": "očekávaný průběh",
      "expected_outcome": "očekávaný výsledek",
      "diagnostic_watch": ["na co pozor"],
      "warnings": ["bezpečnostní poznámky"],
      "difficulty": "snadné|střední|pokročilé",
      "duration": "délka"
    }
  ],
  "general_tips": ["tipy"],
  "sources": [{"title": "název", "url": "URL", "description": "popis"}],
  "karel_notes": "Karlovy poznámky pro ${osobniOsloveni}"
}

PRAVIDLA:
- Každá aktivita = kompletní návod
- Piš česky
- NEVYMÝŠLEJ citace – používej jen zdroje z rozhovoru a rešerše`;

        const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "Jsi klinický supervizní asistent. Odpovídej VŽDY validním JSON." },
              { role: "user", content: synthesisPrompt },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content || "{}";
          try {
            handbook = JSON.parse(content);
          } catch {
            handbook = { topic: thread.topic, summary: content, activities: [], general_tips: [], sources: [], karel_notes: "" };
          }
        } else {
          console.error(`[sync] AI synthesis failed for "${thread.topic}": ${response.status}`);
        }
      } catch (e) {
        console.error(`[sync] Handbook generation failed for "${thread.topic}":`, e);
      }

      if (!handbook) continue;

      // 4b. Create descriptive filename from topic
      const topicName = (handbook.topic || thread.topic || "Bez_tematu")
        .replace(/[^a-zA-Zá-žÁ-Ž0-9\s()–\-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);

      // 4c. Check if doc with this topic already exists (deduplication)
      const existingDoc = knihovnaFiles.find(f => f.name === topicName);
      if (existingDoc) {
        console.log(`[sync] ⏭️ "${topicName}" already exists in 07_Knihovna, skipping`);
        continue;
      }

      // 4d. Convert handbook to formatted text and save as Google Doc
      const formattedText = handbookToFormattedText(handbook);
      try {
        await createFileInFolder(token, topicName, formattedText, knihovnaFolderId);
        savedHandbooks.push(topicName);
        console.log(`[sync] ✅ Saved handbook: "${topicName}"`);
      } catch (e) {
        console.error(`[sync] Failed to save "${topicName}":`, e);
        continue;
      }

      // 4e. Build prehled entry
      const methodNames = (handbook.activities || []).map((a: any) => a.name || "").filter(Boolean).join(", ");
      prehledEntries.push(
        `[${dateStr}] ${topicName}\n` +
        `  Autor: ${normalizedCreatedBy}\n` +
        `  Shrnutí: ${(handbook.summary || "").slice(0, 200)}\n` +
        `  Metody: ${methodNames || "neuvedeny"}\n` +
        `  Dokument v 07_Knihovna: "${topicName}"`
      );
    }

    // 5. UPDATE 00_Prehled with new entries
    if (prehledEntries.length > 0 && prehledFile) {
      const appendText = `\n═══ AKTUALIZACE ${dateStr} ═══\nZpracováno vláken: ${threads.length}\nUloženo příruček: ${savedHandbooks.length}\n\n${prehledEntries.join("\n\n")}`;
      try {
        await appendToGoogleDoc(token, prehledFile.id, appendText);
        console.log(`[sync] ✅ 00_Prehled updated with ${prehledEntries.length} entries`);
      } catch (e) {
        console.error("[sync] Failed to update 00_Prehled:", e);
      }
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
      handbooksSaved: savedHandbooks,
      prehledUpdated: prehledEntries.length > 0,
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
