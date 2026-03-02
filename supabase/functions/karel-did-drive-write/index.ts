import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// ── OAuth2 token helper ──
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

// ── Drive helpers ──
async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=200`, {
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

// Update file by ID directly (PATCH existing) or create new in folder
async function updateFileById(token: string, fileId: string, content: string): Promise<any> {
  const boundary = "----DIDWriteBoundary";
  const metadata = JSON.stringify({ /* keep existing name */ });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed for ${fileId}: ${await res.text()}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----DIDWriteBoundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed for ${fileName}: ${await res.text()}`);
  return await res.json();
}

// ═══ SECTION MANAGEMENT ═══
const SECTION_DEFINITIONS: Record<string, string> = {
  A: "Kdo jsem",
  B: "Charakter a psychologický profil",
  C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení",
  E: "Chronologický log / Handover",
  F: "Poznámky pro Karla",
  G: "Deník sezení",
  H: "Dlouhodobé cíle",
  I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence",
  K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části",
  M: "Karlova analytická poznámka",
};

const SECTION_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

function sectionHeader(letter: string): string {
  return `═══ SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]} ═══`;
}

function parseCardSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Match section headers: "═══ SEKCE X –", "SEKCE X:", "## SEKCE X", "## X –", "A:", "A)" etc.
  const sectionRegex = /(?:═+\s*)?(?:SEKCE\s+)?([A-M])\s*[–\-:)]\s*/gi;
  
  // First try strict format with SEKCE keyword
  const strictRegex = /(?:═+\s*)?SEKCE\s+([A-M])\s*[–\-:]/gi;
  let matches = [...content.matchAll(strictRegex)];
  
  // If no strict matches, try looser format (lines starting with single letter)
  if (matches.length === 0) {
    const looseRegex = /^##?\s*([A-M])\s*[–\-:)]\s*/gmi;
    matches = [...content.matchAll(looseRegex)];
  }

  if (matches.length === 0) {
    sections["_preamble"] = content.trim();
    return sections;
  }

  const beforeFirst = content.slice(0, matches[0].index).trim();
  if (beforeFirst) sections["_preamble"] = beforeFirst;

  for (let i = 0; i < matches.length; i++) {
    const letter = matches[i][1].toUpperCase();
    const headerLineEnd = content.indexOf("\n", matches[i].index!);
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    const sectionContent = content.slice(headerLineEnd > -1 ? headerLineEnd + 1 : matches[i].index! + matches[i][0].length, end).trim();
    sections[letter] = sectionContent;
  }

  return sections;
}

function buildCard(partName: string, sections: Record<string, string>): string {
  const lines: string[] = [];

  if (sections["_preamble"]) {
    lines.push(sections["_preamble"]);
  } else {
    lines.push(`═══ KARTA ČÁSTI: ${partName} ═══`);
  }
  lines.push("");

  for (const letter of SECTION_ORDER) {
    lines.push(sectionHeader(letter));
    lines.push(sections[letter] || "(zatím prázdné)");
    lines.push("");
  }

  return lines.join("\n");
}

interface CardFileResult {
  fileId: string;
  fileName: string;
  content: string;
  parentFolderId: string; // the folder where the card lives
}

// Find the card file for a part name – searches root + all subfolders recursively
async function findCardFile(token: string, partName: string, rootFolderId: string): Promise<CardFileResult | null> {
  const normalizedPart = partName.toLowerCase().replace(/\s+/g, "").replace(/[_-]/g, "");
  
  async function searchFolder(folderId: string): Promise<CardFileResult | null> {
    const files = await listFilesInFolder(token, folderId);
    
    // Search files in this folder – match "Karta_Arthur", "004_Arthur", "Arthur" etc.
    for (const f of files) {
      const isFolder = f.mimeType === "application/vnd.google-apps.folder";
      if (isFolder) continue;
      
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      const normalizedFileName = baseName.toLowerCase().replace(/[_\s-]/g, "");
      
      // Match if file name contains the part name
      if (normalizedFileName.includes(normalizedPart)) {
        try {
          const content = await readFileContent(token, f.id);
          console.log(`[findCardFile] Found card for "${partName}": ${f.name} (id: ${f.id}) in folder ${folderId}`);
          return { fileId: f.id, fileName: f.name, content, parentFolderId: folderId };
        } catch (e) {
          console.error(`[findCardFile] Could not read ${f.name}:`, e);
        }
      }
    }
    
    // Search subfolders
    const subfolders = files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
    for (const sf of subfolders) {
      const result = await searchFolder(sf.id);
      if (result) return result;
    }
    
    return null;
  }
  
  return searchFolder(rootFolderId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await req.json();
    const token = await getAccessToken();

    // Find Kartoteka_DID folder
    let folderId = await findFolder(token, "Kartoteka_DID")
      || await findFolder(token, "Kartotéka_DID")
      || await findFolder(token, "KARTOTEKA_DID");

    if (!folderId) {
      return new Response(JSON.stringify({ error: "Kartoteka_DID folder not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ MODE: "update-card-sections" ═══
    // Updates specific sections of a part's card directly IN PLACE
    // Input: { mode: "update-card-sections", partName: string, sections: Record<string, string> }
    if (body.mode === "update-card-sections") {
      const { partName, sections: newSections } = body;
      if (!partName || !newSections) {
        return new Response(JSON.stringify({ error: "partName and sections required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const card = await findCardFile(token, partName, folderId);
      const dateStr = new Date().toISOString().slice(0, 10);

      let existingSections: Record<string, string>;
      let isNew = false;

      if (card) {
        existingSections = parseCardSections(card.content);
        console.log(`[update-card-sections] Found card: ${card.fileName} (${card.fileId}), sections: ${Object.keys(existingSections).filter(k => k !== "_preamble").join(", ")}`);
      } else {
        existingSections = {};
        isNew = true;
        console.log(`[update-card-sections] No card found for "${partName}", creating new`);
      }

      // Merge: append new content to existing sections with timestamp (NEVER overwrite)
      const updatedKeys: string[] = [];
      for (const [letter, newContent] of Object.entries(newSections)) {
        const upperLetter = letter.toUpperCase();
        if (!SECTION_ORDER.includes(upperLetter)) continue;

        const existing = existingSections[upperLetter] || "";
        const timestampedContent = `[${dateStr}] ${newContent}`;

        if (existing && existing !== "(zatím prázdné)") {
          existingSections[upperLetter] = existing + "\n\n" + timestampedContent;
        } else {
          existingSections[upperLetter] = timestampedContent;
        }
        updatedKeys.push(upperLetter);
      }

      // Rebuild full card with ALL sections A-M
      const fullCard = buildCard(partName, existingSections);

      let resultFileName: string;
      if (card) {
        // UPDATE IN PLACE by file ID – same file, same folder
        await updateFileById(token, card.fileId, fullCard);
        resultFileName = card.fileName;
        console.log(`[update-card-sections] Updated ${card.fileName} in-place (${card.fileId}), sections: ${updatedKeys.join(",")}`);
      } else {
        // Create new card in root of Kartoteka_DID
        const newFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
        await createFileInFolder(token, newFileName, fullCard, folderId);
        resultFileName = newFileName;
        console.log(`[update-card-sections] Created new card: ${newFileName}`);
      }

      return new Response(JSON.stringify({
        success: true,
        cardFileName: resultFileName,
        sectionsUpdated: updatedKeys,
        isNewCard: isNew,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ Fallback: legacy mode (should NOT be used for DID cards) ═══
    return new Response(JSON.stringify({ 
      error: "Use mode: 'update-card-sections' for DID card updates. Legacy 'updates' array mode is disabled." 
    }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DID Drive write error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
