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

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`, {
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
  const existingId = await findFile(token, fileName, folderId);
  const boundary = "----DIDWriteBoundary";
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
  if (!res.ok) throw new Error(`Drive upload failed for ${fileName}: ${await res.text()}`);
  return await res.json();
}

// ═══ SECTION MANAGEMENT ═══
// Mandatory card structure A-M
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

// Parse existing card content into sections
function parseCardSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Match section headers like "═══ SEKCE X –" or "SEKCE X:" or "## SEKCE X" etc.
  const sectionRegex = /(?:═+\s*)?SEKCE\s+([A-M])\s*[–\-:]/gi;
  const matches = [...content.matchAll(sectionRegex)];

  if (matches.length === 0) {
    // No structured sections found – put everything under a preamble
    sections["_preamble"] = content.trim();
    return sections;
  }

  // Content before first section
  const beforeFirst = content.slice(0, matches[0].index).trim();
  if (beforeFirst) sections["_preamble"] = beforeFirst;

  for (let i = 0; i < matches.length; i++) {
    const letter = matches[i][1].toUpperCase();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    // Find end of the header line
    const headerLineEnd = content.indexOf("\n", matches[i].index!);
    const sectionContent = content.slice(headerLineEnd > -1 ? headerLineEnd + 1 : start, end).trim();
    sections[letter] = sectionContent;
  }

  return sections;
}

// Rebuild card from sections
function buildCard(partName: string, sections: Record<string, string>): string {
  const lines: string[] = [];

  // Preamble (title etc.)
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

// Find the card file for a part name (searches Kartoteka_DID root + subfolders)
async function findCardFile(token: string, partName: string, folderId: string): Promise<{ fileId: string; fileName: string; content: string } | null> {
  const normalizedPart = partName.toLowerCase().replace(/\s+/g, "_");
  const files = await listFilesInFolder(token, folderId);

  // Direct match: Karta_Arthur.txt, 004_Arthur.txt, etc.
  const cardFile = files.find(f => {
    const normalized = f.name.toLowerCase().replace(/\.(txt|md|doc|docx)$/i, "").replace(/[_\s-]/g, "");
    return normalized.includes(normalizedPart) && (normalized.includes("karta") || /^\d+/.test(f.name));
  });

  if (cardFile) {
    const content = await readFileContent(token, cardFile.id);
    return { fileId: cardFile.id, fileName: cardFile.name, content };
  }

  // Search in subfolders (01_AKTIVNI_FRAGMENTY, 02_KLASTRY_A_RODOKMENY)
  const subfolders = files.filter(f => !f.name.includes("."));
  for (const sf of subfolders) {
    // Check if it's a folder by trying to list contents
    try {
      const subFiles = await listFilesInFolder(token, sf.id);
      const subCard = subFiles.find(f => {
        const normalized = f.name.toLowerCase().replace(/\.(txt|md|doc|docx)$/i, "").replace(/[_\s-]/g, "");
        return normalized.includes(normalizedPart);
      });
      if (subCard) {
        const content = await readFileContent(token, subCard.id);
        return { fileId: subCard.id, fileName: subCard.name, content };
      }
    } catch { /* not a folder or inaccessible */ }
  }

  return null;
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
    // Updates specific sections of a part's card directly
    // Input: { mode: "update-card-sections", partName: string, sections: Record<string, string> }
    //   sections keys are A-M, values are new content to APPEND (not replace) to that section
    if (body.mode === "update-card-sections") {
      const { partName, sections: newSections } = body;
      if (!partName || !newSections) {
        return new Response(JSON.stringify({ error: "partName and sections required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Find existing card
      const card = await findCardFile(token, partName, folderId);
      const dateStr = new Date().toISOString().slice(0, 10);

      let existingSections: Record<string, string>;
      let cardFileName: string;

      if (card) {
        existingSections = parseCardSections(card.content);
        cardFileName = card.fileName;
        console.log(`Found card: ${cardFileName}, existing sections: ${Object.keys(existingSections).join(", ")}`);
      } else {
        // Create new card
        existingSections = {};
        cardFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
        console.log(`Creating new card: ${cardFileName}`);
      }

      // Merge: append new content to existing sections (never overwrite)
      for (const [letter, newContent] of Object.entries(newSections)) {
        const upperLetter = letter.toUpperCase();
        if (!SECTION_ORDER.includes(upperLetter)) continue;

        const existing = existingSections[upperLetter] || "";
        const timestampedContent = `\n[${dateStr}] ${newContent}`;

        if (existing && existing !== "(zatím prázdné)") {
          existingSections[upperLetter] = existing + "\n" + timestampedContent;
        } else {
          existingSections[upperLetter] = timestampedContent.trim();
        }
      }

      // Rebuild full card
      const fullCard = buildCard(partName, existingSections);
      await uploadOrUpdate(token, cardFileName, fullCard, folderId);

      return new Response(JSON.stringify({
        success: true,
        cardFileName,
        sectionsUpdated: Object.keys(newSections),
        isNewCard: !card,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ MODE: legacy "updates" array (append/replace) ═══
    // Kept for backward compatibility but should not create separate backup files
    const { updates } = body;
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return new Response(JSON.stringify({ error: "No updates provided. Use mode: 'update-card-sections' for section-based writes." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ fileName: string; status: string }> = [];

    for (const update of updates) {
      const { fileName, content, mode: writeMode } = update;
      if (!fileName || !content) {
        results.push({ fileName: fileName || "unknown", status: "skipped - missing data" });
        continue;
      }

      try {
        if (writeMode === "append") {
          const existingId = await findFile(token, fileName, folderId);
          let existingContent = "";
          if (existingId) existingContent = await readFileContent(token, existingId);
          const newContent = existingContent ? `${existingContent}\n\n${content}` : content;
          await uploadOrUpdate(token, fileName, newContent, folderId);
        } else {
          await uploadOrUpdate(token, fileName, content, folderId);
        }
        results.push({ fileName, status: "ok" });
      } catch (e) {
        console.error(`Failed to write ${fileName}:`, e);
        results.push({ fileName, status: `error: ${e.message}` });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DID Drive write error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
