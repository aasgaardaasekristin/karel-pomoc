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
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

async function updateFileById(token: string, fileId: string, content: string): Promise<any> {
  const boundary = "----DIDCycleBoundary";
  const metadata = JSON.stringify({});
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed: ${await res.text()}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----DIDCycleBoundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
  return await res.json();
}

// Also keep uploadOrUpdate for daily report file (not a card)
async function uploadOrUpdate(token: string, fileName: string, content: string, folderId: string) {
  const existingId = await findFile(token, fileName, folderId);
  if (existingId) {
    return await updateFileById(token, existingId, content);
  }
  return await createFileInFolder(token, fileName, content, folderId);
}

// ═══ CARD SECTION MANAGEMENT ═══
const SECTION_DEFINITIONS: Record<string, string> = {
  A: "Kdo jsem", B: "Charakter a psychologický profil", C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení", E: "Chronologický log / Handover", F: "Poznámky pro Karla",
  G: "Deník sezení", H: "Dlouhodobé cíle", I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence", K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části", M: "Karlova analytická poznámka",
};
const SECTION_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

function sectionHeader(letter: string): string {
  return `═══ SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]} ═══`;
}

function parseCardSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const strictRegex = /(?:═+\s*)?SEKCE\s+([A-M])\s*[–\-:]/gi;
  let matches = [...content.matchAll(strictRegex)];
  if (matches.length === 0) {
    const looseRegex = /^##?\s*([A-M])\s*[–\-:)]\s*/gmi;
    matches = [...content.matchAll(looseRegex)];
  }
  if (matches.length === 0) { sections["_preamble"] = content.trim(); return sections; }
  const beforeFirst = content.slice(0, matches[0].index).trim();
  if (beforeFirst) sections["_preamble"] = beforeFirst;
  for (let i = 0; i < matches.length; i++) {
    const letter = matches[i][1].toUpperCase();
    const headerLineEnd = content.indexOf("\n", matches[i].index!);
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    sections[letter] = content.slice(headerLineEnd > -1 ? headerLineEnd + 1 : matches[i].index! + matches[i][0].length, end).trim();
  }
  return sections;
}

function buildCard(partName: string, sections: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(sections["_preamble"] || `═══ KARTA ČÁSTI: ${partName} ═══`);
  lines.push("");
  for (const letter of SECTION_ORDER) {
    lines.push(sectionHeader(letter));
    lines.push(sections[letter] || "(zatím prázdné)");
    lines.push("");
  }
  return lines.join("\n");
}

interface CardFileResult { fileId: string; fileName: string; content: string; parentFolderId: string; }

async function findCardFile(token: string, partName: string, rootFolderId: string): Promise<CardFileResult | null> {
  const normalizedPart = partName.toLowerCase().replace(/\s+/g, "").replace(/[_-]/g, "");

  async function searchFolder(folderId: string): Promise<CardFileResult | null> {
    const files = await listFilesInFolder(token, folderId);
    for (const f of files) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      const normalizedFileName = baseName.toLowerCase().replace(/[_\s-]/g, "");
      if (normalizedFileName.includes(normalizedPart)) {
        try {
          const content = await readFileContent(token, f.id);
          console.log(`[findCardFile] Found "${partName}": ${f.name} (${f.id}) in folder ${folderId}`);
          return { fileId: f.id, fileName: f.name, content, parentFolderId: folderId };
        } catch (e) { console.error(`[findCardFile] Cannot read ${f.name}:`, e); }
      }
    }
    const subfolders = files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
    for (const sf of subfolders) {
      const result = await searchFolder(sf.id);
      if (result) return result;
    }
    return null;
  }

  return searchFolder(rootFolderId);
}

// Update card sections in-place by file ID
async function updateCardSections(token: string, partName: string, newSections: Record<string, string>, folderId: string): Promise<{ fileName: string; sectionsUpdated: string[]; isNew: boolean }> {
  const card = await findCardFile(token, partName, folderId);
  const dateStr = new Date().toISOString().slice(0, 10);
  let existingSections: Record<string, string>;
  let isNew = false;

  if (card) {
    existingSections = parseCardSections(card.content);
    console.log(`[updateCardSections] Card: ${card.fileName}, existing sections: ${Object.keys(existingSections).filter(k => k !== "_preamble").join(",")}`);
  } else {
    existingSections = {};
    isNew = true;
  }

  const updatedKeys: string[] = [];
  for (const [letter, newContent] of Object.entries(newSections)) {
    const ul = letter.toUpperCase();
    if (!SECTION_ORDER.includes(ul)) continue;
    const existing = existingSections[ul] || "";
    const timestamped = `[${dateStr}] ${newContent}`;
    if (existing && existing !== "(zatím prázdné)") {
      existingSections[ul] = existing + "\n\n" + timestamped;
    } else {
      existingSections[ul] = timestamped;
    }
    updatedKeys.push(ul);
  }

  const fullCard = buildCard(partName, existingSections);

  if (card) {
    // UPDATE IN-PLACE by file ID
    await updateFileById(token, card.fileId, fullCard);
    return { fileName: card.fileName, sectionsUpdated: updatedKeys, isNew: false };
  } else {
    const newFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
    await createFileInFolder(token, newFileName, fullCard, folderId);
    return { fileName: newFileName, sectionsUpdated: updatedKeys, isNew: true };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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

    // 1. SBĚR DAT
    const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { data: threads } = await sb.from("did_threads").select("*").eq("is_processed", false).gte("started_at", cutoff);

    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No threads to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: cycle } = await sb.from("did_update_cycles").insert({ cycle_type: "daily", status: "running" }).select().single();

    // 2. COMPILE THREAD DATA
    const threadSummaries = threads.map(t => {
      const msgs = (t.messages as any[]) || [];
      return `=== Vlákno: ${t.part_name} (${t.sub_mode}) ===\nJazyk: ${t.part_language}\nZačátek: ${t.started_at}\nPoslední aktivita: ${t.last_activity_at}\nPočet zpráv: ${msgs.length}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? "ČÁST/UŽIVATEL" : "KAREL"}]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    // Get Drive context + existing cards
    let driveContext = "";
    let existingCards: Record<string, string> = {};
    const token = await getAccessToken();
    const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");

    if (folderId) {
      try {
        const partsFileId = await findFile(token, "00_Seznam_casti.txt", folderId);
        if (partsFileId) driveContext = await readFileContent(token, partsFileId);
      } catch (e) { console.error("Drive read error:", e); }

      const activeParts = [...new Set(threads.map(t => t.part_name))];
      for (const partName of activeParts) {
        try {
          const card = await findCardFile(token, partName, folderId);
          if (card) existingCards[partName] = card.content.slice(0, 3000);
        } catch {}
      }
    }

    // 3. AI ANALÝZA
    const existingCardsContext = Object.entries(existingCards).map(([name, content]) =>
      `=== EXISTUJÍCÍ KARTA: ${name} ===\n${content}`
    ).join("\n\n");

    const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – analytik DID systému. Zpracuj data z dnešních rozhovorů.

TVÝM ÚKOLEM JE:
1. Pro KAŽDOU aktivní část vytvořit aktualizace sekcí karty (A-M).
2. Vytvořit report pro email.

VÝSTUPNÍ FORMÁT – STRIKTNĚ DODRŽUJ:

Pro každou část vypiš aktualizace sekcí takto:
[KARTA:jméno_části]
[SEKCE:G] deník sezení – datum, co se dělo, stabilizační opatření, další krok (formát: | Datum | Co se dělo | Stabilizace | Další krok |)
[SEKCE:J] krátkodobé cíle a aktuální intervence
[SEKCE:L] aktivita a přítomnost (formát: | Období | Aktivita | Poznámka |)
[SEKCE:E] chronologický log s datem
[SEKCE:K] výstupy ze sezení a zpětná vazba (formát: | Datum | Co bylo navrženo | Výsledek | Hodnocení |)
[/KARTA]

Po všech kartách přidej:
[REPORT]
Report pro email – co bylo změněno, kde (karta + sekce), proč, co plyne pro zítřek, návrh aktivity.
[/REPORT]

PRAVIDLA:
- NIKDY nesmaž původní data – pouze doplňuj s datem
- Zaznamenej zdroj každé změny
- Přizpůsob jazyk části (norsky pro norské části, česky pro ostatní)
- Pokud detekuješ novou část, navrhni obsah pro sekce A, B, C, D, F

${driveContext ? `\nSOUČASNÝ SEZNAM ČÁSTÍ:\n${driveContext}` : ""}
${existingCardsContext ? `\nEXISTUJÍCÍ KARTY:\n${existingCardsContext}` : ""}`,
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

    // 4. PARSE AND UPDATE CARDS IN-PLACE
    const cardsUpdated: string[] = [];

    if (folderId && analysisText) {
      const dateStr = new Date().toISOString().slice(0, 10);

      const cardBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      for (const match of analysisText.matchAll(cardBlockRegex)) {
        const partName = match[1].trim();
        const cardBlock = match[2];

        const sectionRegex = /\[SEKCE:([A-M])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
        const newSections: Record<string, string> = {};
        for (const sm of cardBlock.matchAll(sectionRegex)) {
          const letter = sm[1].toUpperCase();
          const content = sm[2].trim();
          if (content) newSections[letter] = content;
        }

        if (Object.keys(newSections).length > 0) {
          try {
            const result = await updateCardSections(token, partName, newSections, folderId);
            cardsUpdated.push(`${partName} (${result.sectionsUpdated.join(",")}${result.isNew ? " – NOVÁ" : ""})`);
            console.log(`Updated card: ${result.fileName}, sections: ${result.sectionsUpdated.join(",")}`);
          } catch (e) {
            console.error(`Failed to update card for ${partName}:`, e);
          }
        }
      }

      // Daily report (separate file – this IS correct as a standalone report)
      const reportMatch = analysisText.match(/\[REPORT\]([\s\S]*?)\[\/REPORT\]/);
      const reportText = reportMatch?.[1]?.trim() || analysisText;
      await uploadOrUpdate(token, `DID_Denni_Report_${dateStr}.txt`, reportText, folderId);

      // 5. EMAIL
      if (RESEND_API_KEY && reportText) {
        try {
          const resend = new Resend(RESEND_API_KEY);
          const dateCz = new Date().toLocaleDateString("cs-CZ");

          let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${reportText}</pre>`;
          try {
            const fmtRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: "Přeformátuj do čistého HTML emailu. Zachovej obsah, přidej h2, p, ul, li, strong. Přidej seznam aktualizovaných karet: " + cardsUpdated.join(", ") + ". Vrať POUZE HTML." },
                  { role: "user", content: reportText },
                ],
              }),
            });
            if (fmtRes.ok) {
              const fmtData = await fmtRes.json();
              const formatted = fmtData.choices?.[0]?.message?.content;
              if (formatted) htmlContent = formatted.replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
            }
          } catch {}

          await resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [MAMKA_EMAIL], subject: `Karel – Report aktualizace ${dateCz}`, html: htmlContent });
          await resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [KATA_EMAIL], subject: `Karel – Denní report DID ${dateCz}`, html: htmlContent });
          console.log(`Reports sent to ${MAMKA_EMAIL} and ${KATA_EMAIL}`);
        } catch (e) { console.error("Email send error:", e); }
      }
    }

    // 6. Mark threads as processed
    const threadIds = threads.map(t => t.id);
    await sb.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", threadIds);

    if (cycle) {
      await sb.from("did_update_cycles").update({
        status: "completed", completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000), cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
    }

    return new Response(JSON.stringify({ success: true, threadsProcessed: threads.length, cardsUpdated, reportSent: !!RESEND_API_KEY }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Daily cycle error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
