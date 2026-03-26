import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// Minimal edge function for updating DID part card sections (A-M)
// Separated from karel-did-drive-write to avoid memory limits

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

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

const stripDiacritics = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const canonical = (v: string) => stripDiacritics(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreName(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 10;
  if (a.includes(b) || b.includes(a)) return 7;
  if (a.slice(0, 6) === b.slice(0, 6)) return 3;
  return 0;
}

type DriveFile = { id: string; name: string; mimeType?: string };

async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readFile(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Cannot read ${fileId}: ${res.status}`);
  return await res.text();
}

async function updateDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) throw new Error(`Docs read failed: ${docRes.status}`);
  const docData = await docRes.json();
  const bodyContent = docData?.body?.content || [];
  const lastEnd = bodyContent.length > 0 ? Number(bodyContent[bodyContent.length - 1]?.endIndex || 1) : 1;
  // Free docData from memory
  const requests: any[] = [];
  if (lastEnd > 1) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: lastEnd - 1 } } });
  requests.push({ insertText: { location: { index: 1 }, text: content } });
  const upRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!upRes.ok) throw new Error(`Docs update failed: ${upRes.status}`);
  await upRes.text(); // consume body
}

// Section definitions
const SECTIONS: Record<string, string> = {
  A: "Kdo jsem", B: "Charakter a psychologický profil", C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení", E: "Chronologický log / Handover", F: "Poznámky pro Karla",
  G: "Deník sezení", H: "Dlouhodobé cíle", I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence", K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části", M: "Karlova analytická poznámka",
};
const SECTION_ORDER = ["A","B","C","D","E","F","G","H","I","J","K","L","M"];

function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const regex = /(?:═+\s*)?SEKCE\s+([A-M])\s*[–\-:]/gi;
  let matches = [...content.matchAll(regex)];
  if (matches.length === 0) {
    const loose = /^##?\s*([A-M])\s*[–\-:)]\s*/gmi;
    matches = [...content.matchAll(loose)];
  }
  if (matches.length === 0) { sections["_preamble"] = content.trim(); return sections; }
  const before = content.slice(0, matches[0].index).trim();
  if (before) sections["_preamble"] = before;
  for (let i = 0; i < matches.length; i++) {
    const letter = matches[i][1].toUpperCase();
    const headerEnd = content.indexOf("\n", matches[i].index!);
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    sections[letter] = content.slice(headerEnd > -1 ? headerEnd + 1 : matches[i].index! + matches[i][0].length, end).trim();
  }
  return sections;
}

function buildCard(partName: string, sections: Record<string, string>): string {
  const lines: string[] = [sections["_preamble"] || `KARTA ČÁSTI: ${partName.toUpperCase()}`, ""];
  for (const l of SECTION_ORDER) {
    lines.push(`SEKCE ${l} – ${SECTIONS[l]}`);
    lines.push(sections[l] || "(zatím prázdné)");
    lines.push("");
  }
  return lines.join("\n");
}

async function findCard(token: string, partName: string, folderId: string): Promise<{ fileId: string; name: string; content: string } | null> {
  const norm = canonical(partName);
  const files = await listFiles(token, folderId);
  // Check files first
  for (const f of files) {
    if (f.mimeType === FOLDER_MIME) continue;
    if (scoreName(norm, canonical(f.name.replace(/\.(txt|md|doc|docx)$/i, ""))) > 0) {
      try {
        const content = await readFile(token, f.id);
        console.log(`[card-update] Found: ${f.name} (${f.id})`);
        return { fileId: f.id, name: f.name, content };
      } catch (e) { console.error(`Cannot read ${f.name}:`, e); }
    }
  }
  // Check subfolders
  for (const f of files) {
    if (f.mimeType !== FOLDER_MIME) continue;
    const result = await findCard(token, partName, f.id);
    if (result) return result;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__";
  if (authHeader !== `Bearer ${srvKey}`) {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
  }

  try {
    const { partName, sections: newSections, sectionModes: modes } = await req.json();
    if (!partName || !newSections) {
      return new Response(JSON.stringify({ error: "partName and sections required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();
    const dateStr = new Date().toISOString().slice(0, 10);

    // Find kartoteka root
    const rootId = await findFolder(token, "kartoteka_DID")
      || await findFolder(token, "Kartoteka_DID")
      || await findFolder(token, "Kartotéka_DID");
    if (!rootId) {
      return new Response(JSON.stringify({ error: "kartoteka_DID not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find active/archive folders
    const rootFiles = await listFiles(token, rootId);
    const folders = rootFiles.filter(f => f.mimeType === FOLDER_MIME);
    const activeId = folders.find(f => /^01/.test(f.name.trim()) || canonical(f.name).includes("aktiv"))?.id;
    const archiveId = folders.find(f => /^03/.test(f.name.trim()) || canonical(f.name).includes("archiv"))?.id;

    // Search for card: active → archive → root
    let card: Awaited<ReturnType<typeof findCard>> = null;
    for (const fid of [activeId, archiveId, rootId].filter(Boolean) as string[]) {
      card = await findCard(token, partName, fid);
      if (card) break;
    }

    if (!card) {
      return new Response(JSON.stringify({ error: `Card "${partName}" not found` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse and merge
    const existing = parseSections(card.content);
    const sectionModes: Record<string, string> = modes || {};
    const updated: string[] = [];

    for (const [letter, newContent] of Object.entries(newSections)) {
      const ul = letter.toUpperCase();
      if (!SECTION_ORDER.includes(ul)) continue;
      const old = existing[ul] || "";
      const mode = (sectionModes[ul] || "APPEND").toUpperCase();
      const stamped = `[${dateStr}] ${newContent}`;

      if (mode === "REPLACE" || mode === "ROTATE") {
        existing[ul] = stamped;
      } else {
        existing[ul] = (old && old !== "(zatím prázdné)") ? old + "\n\n" + stamped : stamped;
      }
      updated.push(ul);
      console.log(`[card-update] ${mode} ${ul} (${String(newContent).length} chars)`);
    }

    const fullCard = buildCard(partName, existing);
    await updateDocInPlace(token, card.fileId, fullCard);
    console.log(`[card-update] ✅ Updated ${card.name}, sections: ${updated.join(",")}`);

    return new Response(JSON.stringify({
      success: true, cardFileName: card.name, sectionsUpdated: updated,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[card-update] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
