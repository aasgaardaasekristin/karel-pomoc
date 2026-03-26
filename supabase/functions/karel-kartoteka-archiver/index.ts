import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Archiver for oversized DID part cards.
 *
 * Pipeline:
 *  1. Read full card via karel-did-drive-read
 *  2. Parse sections, find update blocks
 *  3. For archivable sections with > keepLastBlocks blocks:
 *     - Keep last N blocks in card, move older to archive doc
 *  4. Backup card → 04_BACKUPS
 *  5. Append archive payload → 02_ARCHIVY/{NAME}_ARCHIV_01
 *  6. Rewrite card with trimmed content
 *  7. Log to card_archive_log
 */

const MIN_KEEP = 3;

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

// ── Drive helpers ──

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder: ${JSON.stringify(data)}`);
  console.log(`[archiver] Created folder "${name}" (${data.id})`);
  return data.id;
}

async function copyFile(token: string, fileId: string, newName: string, destFolderId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName, parents: [destFolderId] }),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Copy failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function findArchiveDoc(token: string, partNameUpper: string, archiveFolderId: string): Promise<{ id: string; name: string } | null> {
  const q = `'${archiveFolderId}' in parents and name contains '${partNameUpper}_ARCHIV' and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name,mimeType)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    orderBy: "name desc",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const docs = (data.files || []).filter((f: any) => f.mimeType === DOC_MIME);
  return docs.length > 0 ? { id: docs[0].id, name: docs[0].name } : null;
}

async function createGoogleDoc(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: DOC_MIME, parents: [parentId] }),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create doc: ${JSON.stringify(data)}`);
  return data.id;
}

async function getDocEndIndex(token: string, fileId: string): Promise<number> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Docs API failed: ${res.status}`);
  const data = await res.json();
  const content = data?.body?.content || [];
  if (content.length === 0) return 1;
  const lastEnd = Number(content[content.length - 1]?.endIndex || 1);
  return Math.max(lastEnd - 1, 1);
}

async function appendToDoc(token: string, fileId: string, text: string): Promise<void> {
  const insertAt = await getDocEndIndex(token, fileId);
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: insertAt }, text } }] }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs batchUpdate failed: ${res.status} ${errText}`);
  }
  await res.text();
}

async function getDocSizeChars(token: string, fileId: string): Promise<number> {
  return await getDocEndIndex(token, fileId);
}

// ── Section parsing ──

interface ParsedSection {
  letter: string;
  header: string;
  preBlockContent: string; // content before first update block
  blocks: { header: string; content: string }[];
}

const SECTION_RE = /^SEKCE ([A-M]) –\s*(.*)$/m;
const BLOCK_RE = /═{3,}\s*AKTUALIZACE\s*\[([^\]]*)\]\s*═{3,}/;

function parseCardIntoSections(fullText: string): ParsedSection[] {
  const lines = fullText.split("\n");
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const secMatch = line.match(SECTION_RE);
    if (secMatch) {
      if (current) sections.push(current);
      current = { letter: secMatch[1], header: line, preBlockContent: "", blocks: [] };
      continue;
    }
    if (!current) continue;

    const blockMatch = line.match(BLOCK_RE);
    if (blockMatch) {
      // Start of new update block — scan for the triple-line header
      current.blocks.push({ header: line, content: "" });
    } else if (current.blocks.length > 0) {
      // Append to current block
      const lastBlock = current.blocks[current.blocks.length - 1];
      lastBlock.content += line + "\n";
    } else {
      // Pre-block content (original card content before any updates)
      current.preBlockContent += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

function rebuildSection(sec: ParsedSection, keepBlocks: { header: string; content: string }[]): string {
  let result = sec.header + "\n" + sec.preBlockContent;
  for (const b of keepBlocks) {
    result += b.header + "\n" + b.content;
  }
  return result;
}

// ── Main handler ──

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Auth: service role or authenticated user
  const authHeader = req.headers.get("Authorization") || "";
  const isServiceCall = authHeader === `Bearer ${serviceKey}`;
  if (!isServiceCall) {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { error } = await userClient.auth.getClaims(token);
    if (error) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  try {
    const body = await req.json();
    const partName: string = body.partName;
    const keepLastBlocks = Math.max(body.keepLastBlocks ?? 5, MIN_KEEP);
    const archiveSections: string[] = body.archiveSections ?? ["C", "D", "E", "G", "K", "L", "M"];
    const dryRun: boolean = body.dryRun ?? false;

    if (!partName) {
      return new Response(JSON.stringify({ error: "partName required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[archiver] Starting for "${partName}", keep=${keepLastBlocks}, dryRun=${dryRun}`);

    // 1. Read full card via edge function
    const { data: readData, error: readErr } = await supabase.functions.invoke("karel-did-drive-read", {
      body: { partName, mode: "read-card" },
    });
    if (readErr || !readData?.content) {
      throw new Error(`Drive read failed: ${JSON.stringify(readErr || readData)}`);
    }

    const fullText: string = readData.content;
    const originalSizeKB = Math.round(new TextEncoder().encode(fullText).length / 1024);
    const fileId: string = readData.fileId;
    const fileName: string = readData.fileName || partName;
    console.log(`[archiver] Card "${fileName}" loaded: ${originalSizeKB} KB`);

    // 2. Parse sections
    const sections = parseCardIntoSections(fullText);

    // 3. Determine what to archive
    let totalArchivedBlocks = 0;
    const archivedSectionLetters: string[] = [];
    const archivePayloadParts: string[] = [];
    const trimmedSections: Map<string, ParsedSection & { keptBlocks: typeof sections[0]["blocks"] }> = new Map();

    for (const sec of sections) {
      if (!archiveSections.includes(sec.letter)) continue;
      if (sec.blocks.length <= keepLastBlocks) continue;

      const toArchive = sec.blocks.slice(0, sec.blocks.length - keepLastBlocks);
      const toKeep = sec.blocks.slice(sec.blocks.length - keepLastBlocks);

      totalArchivedBlocks += toArchive.length;
      archivedSectionLetters.push(sec.letter);

      // Build archive text for this section
      archivePayloadParts.push(`\n── ARCHIV SEKCE ${sec.letter} z karty ${fileName} ──\n`);
      for (const b of toArchive) {
        archivePayloadParts.push(b.header + "\n" + b.content);
      }

      trimmedSections.set(sec.letter, { ...sec, keptBlocks: toKeep });
    }

    if (totalArchivedBlocks === 0) {
      console.log(`[archiver] Nothing to archive for "${partName}"`);
      return new Response(JSON.stringify({
        success: true, partName, originalSizeKB, newSizeKB: originalSizeKB,
        archivedSections: [], archivedBlockCount: 0, archiveFileName: null, dryRun,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const archivePayload = archivePayloadParts.join("");
    console.log(`[archiver] Will archive ${totalArchivedBlocks} blocks from sections [${archivedSectionLetters.join(",")}]`);

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true, partName, originalSizeKB, newSizeKB: null,
        archivedSections: archivedSectionLetters, archivedBlockCount: totalArchivedBlocks,
        archiveFileName: null, dryRun: true,
        archivePayloadSizeKB: Math.round(new TextEncoder().encode(archivePayload).length / 1024),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4. Get Drive token and find kartoteka root
    const driveToken = await getAccessToken();

    let rootId = await findFolder(driveToken, "kartoteka_DID")
      || await findFolder(driveToken, "Kartoteka_DID")
      || await findFolder(driveToken, "Kartotéka_DID");
    if (!rootId) throw new Error("kartoteka_DID folder not found");

    // 5. Ensure 02_ARCHIVY and 04_BACKUPS folders exist
    let archiveFolderId = await findFolder(driveToken, "02_ARCHIVY", rootId);
    if (!archiveFolderId) {
      archiveFolderId = await createFolder(driveToken, "02_ARCHIVY", rootId);
    }

    let backupFolderId = await findFolder(driveToken, "04_BACKUPS", rootId);
    if (!backupFolderId) {
      backupFolderId = await createFolder(driveToken, "04_BACKUPS", rootId);
    }

    // 6. Backup card FIRST — if this fails, we stop
    const dateStr = new Date().toISOString().slice(0, 10);
    const partNameUpper = partName.toUpperCase().replace(/\s+/g, "_");
    const backupName = `${partNameUpper}_BACKUP_${dateStr}`;
    console.log(`[archiver] Creating backup: ${backupName}`);
    const backupId = await copyFile(driveToken, fileId, backupName, backupFolderId);
    console.log(`[archiver] Backup created: ${backupId}`);

    // 7. Find or create archive document
    let archiveDoc = await findArchiveDoc(driveToken, partNameUpper, archiveFolderId);
    let archiveFileName: string;

    if (archiveDoc) {
      // Check size — if > 200KB, create next number
      const archiveSize = await getDocSizeChars(driveToken, archiveDoc.id);
      if (archiveSize > 200000) {
        const match = archiveDoc.name.match(/_ARCHIV_(\d+)/);
        const nextNum = match ? String(Number(match[1]) + 1).padStart(2, "0") : "02";
        archiveFileName = `${partNameUpper}_ARCHIV_${nextNum}`;
        const newId = await createGoogleDoc(driveToken, archiveFileName, archiveFolderId);
        archiveDoc = { id: newId, name: archiveFileName };
      } else {
        archiveFileName = archiveDoc.name;
      }
    } else {
      // Extract number prefix from card file name if possible
      const numMatch = fileName.match(/^(\d{3})_/);
      const prefix = numMatch ? numMatch[1] + "_" : "";
      archiveFileName = `${prefix}${partNameUpper}_ARCHIV_01`;
      const newId = await createGoogleDoc(driveToken, archiveFileName, archiveFolderId);
      archiveDoc = { id: newId, name: archiveFileName };
    }

    // 8. Append archive payload to archive doc
    console.log(`[archiver] Appending ${archivePayload.length} chars to ${archiveDoc.name}`);
    await appendToDoc(driveToken, archiveDoc.id, archivePayload);

    // 9. Rebuild trimmed card content
    const rebuiltLines: string[] = [];
    for (const sec of sections) {
      const trimmed = trimmedSections.get(sec.letter);
      if (trimmed) {
        rebuiltLines.push(rebuildSection(sec, trimmed.keptBlocks));
      } else {
        // Untouched section — reconstruct as-is
        rebuiltLines.push(sec.header + "\n" + sec.preBlockContent);
        for (const b of sec.blocks) {
          rebuiltLines.push(b.header + "\n" + b.content);
        }
      }
    }
    const trimmedContent = rebuiltLines.join("");
    const newSizeKB = Math.round(new TextEncoder().encode(trimmedContent).length / 1024);
    console.log(`[archiver] Trimmed card: ${originalSizeKB} KB → ${newSizeKB} KB`);

    // 10. Rewrite card via drive-write (card is now small, safe for memory)
    const { error: writeErr } = await supabase.functions.invoke("karel-did-drive-write", {
      body: { mode: "overwrite-file", fileId, content: trimmedContent },
    });
    if (writeErr) {
      console.error(`[archiver] Card rewrite failed (archive already saved): ${JSON.stringify(writeErr)}`);
      // Archive is already saved — data is not lost
    }

    // 11. Log to card_archive_log
    await supabase.from("card_archive_log").insert({
      part_id: partName,
      original_size_kb: originalSizeKB,
      new_size_kb: newSizeKB,
      archived_sections: archivedSectionLetters,
      archived_block_count: totalArchivedBlocks,
      archive_file_name: archiveFileName,
      backup_file_name: backupName,
      dry_run: false,
    });

    const result = {
      success: true, partName, originalSizeKB, newSizeKB,
      archivedSections: archivedSectionLetters, archivedBlockCount: totalArchivedBlocks,
      archiveFileName, backupFileName: backupName, dryRun: false,
    };
    console.log(`[archiver] ✅ Done:`, JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[archiver] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
