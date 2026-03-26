import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

/**
 * Minimal edge function for appending updates to DID part cards.
 * 
 * KEY DESIGN: Never reads full card content into memory.
 * Uses Google Docs API structurally — gets endIndex and appends via insertText.
 * This keeps memory usage minimal even for 200KB+ cards.
 *
 * TODO (Řešení 3): When a card exceeds 100 KB, archive older entries
 * from sections E (Chronologický log), G (Deník sezení), K (Výstupy)
 * into a separate "{NAME}_ARCHIV" document.
 */

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

/**
 * Find the card file ID WITHOUT reading its content.
 * Returns only { fileId, name } — no content loaded into memory.
 */
async function findCardFileId(token: string, partName: string, folderId: string): Promise<{ fileId: string; name: string } | null> {
  const norm = canonical(partName);
  const files = await listFiles(token, folderId);

  for (const f of files) {
    if (f.mimeType === FOLDER_MIME) continue;
    if (scoreName(norm, canonical(f.name.replace(/\.(txt|md|doc|docx)$/i, ""))) > 0) {
      console.log(`[card-update] Found card: ${f.name} (${f.id})`);
      return { fileId: f.id, name: f.name };
    }
  }
  // Recurse into subfolders
  for (const f of files) {
    if (f.mimeType !== FOLDER_MIME) continue;
    const result = await findCardFileId(token, partName, f.id);
    if (result) return result;
  }
  return null;
}

/**
 * Get the endIndex of the document using a MINIMAL Docs API call.
 * We request only body.content endIndex — not the full text content.
 * For a 210KB doc, the structural metadata is ~5-10KB vs ~500KB+ for full export.
 */
async function getDocEndIndex(token: string, fileId: string): Promise<number> {
  // Use fields mask to get ONLY the structural info we need
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Docs API failed: ${res.status}`);
  const data = await res.json();
  const content = data?.body?.content || [];
  if (content.length === 0) return 1;
  // endIndex of the last structural element
  const lastEnd = Number(content[content.length - 1]?.endIndex || 1);
  // insertText index must be endIndex - 1 (before the trailing newline)
  return Math.max(lastEnd - 1, 1);
}

/**
 * Append text at the end of the document using batchUpdate.
 * No reading of full content — just structural endIndex + insertText.
 */
async function appendToDoc(token: string, fileId: string, text: string): Promise<void> {
  const insertAt = await getDocEndIndex(token, fileId);

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: insertAt }, text } }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs batchUpdate failed: ${res.status} ${errText}`);
  }
  await res.text(); // consume response body
}

const SECTIONS: Record<string, string> = {
  A: "Kdo jsem", B: "Charakter a psychologický profil", C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení", E: "Chronologický log / Handover", F: "Poznámky pro Karla",
  G: "Deník sezení", H: "Dlouhodobé cíle", I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence", K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části", M: "Karlova analytická poznámka",
};
const SECTION_ORDER = ["A","B","C","D","E","F","G","H","I","J","K","L","M"];

/**
 * Build an append-only block of text from the section updates.
 * Format:
 *   ═══ AKTUALIZACE [2026-03-26] ═══
 *   SEKCE A – Kdo jsem: <new text>
 *   SEKCE C – Potřeby...: <new text>
 */
function buildAppendBlock(dateStr: string, sections: Record<string, string>): string {
  const lines: string[] = [
    "",
    `═══════════════════════════════════════`,
    `═══ AKTUALIZACE [${dateStr}] ═══`,
    `═══════════════════════════════════════`,
  ];

  for (const letter of SECTION_ORDER) {
    const content = sections[letter];
    if (!content || content.trim() === "") continue;
    lines.push("");
    lines.push(`SEKCE ${letter} – ${SECTIONS[letter]}:`);
    lines.push(content.trim());
  }

  lines.push("");
  return lines.join("\n");
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
    const { partName, sections: newSections } = await req.json();
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

    // Search for card: active → archive → root (NO content reading)
    let card: { fileId: string; name: string } | null = null;
    for (const fid of [activeId, archiveId, rootId].filter(Boolean) as string[]) {
      card = await findCardFileId(token, partName, fid);
      if (card) break;
    }

    if (!card) {
      return new Response(JSON.stringify({ error: `Card "${partName}" not found` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build append block from provided sections
    const nonEmpty = Object.entries(newSections).filter(([k, v]) =>
      SECTION_ORDER.includes(k.toUpperCase()) && v && String(v).trim() !== ""
    );
    if (nonEmpty.length === 0) {
      return new Response(JSON.stringify({ success: true, cardFileName: card.name, sectionsUpdated: [], note: "No non-empty sections to append" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedSections: Record<string, string> = {};
    for (const [k, v] of nonEmpty) {
      normalizedSections[k.toUpperCase()] = String(v);
    }

    const appendText = buildAppendBlock(dateStr, normalizedSections);
    console.log(`[card-update] Appending ${appendText.length} chars to ${card.name} (${card.fileId})`);

    // Append to document — NO full content read
    await appendToDoc(token, card.fileId, appendText);

    const updated = Object.keys(normalizedSections).sort();
    console.log(`[card-update] ✅ Appended to ${card.name}, sections: ${updated.join(",")}`);

    return new Response(JSON.stringify({
      success: true, cardFileName: card.name, sectionsUpdated: updated,
      appendedChars: appendText.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[card-update] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
