import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import * as XLSX from "npm:xlsx@0.18.5";
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
  const params = new URLSearchParams({
    q,
    fields: "files(id)",
    pageSize: "50",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id)",
    pageSize: "50",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "200",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return allFiles;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLS_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const canonicalText = (value: string) =>
  stripDiacritics(value || "")
    .toLowerCase()
    .replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "")
    .replace(/[^a-z0-9]/g, "");

function scoreNameMatch(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 10;
  if (left.includes(right) || right.includes(left)) return 7;
  if (left.slice(0, 6) === right.slice(0, 6)) return 3;
  return 0;
}

async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!docRes.ok) {
    throw new Error(`Docs read failed (${docRes.status}): ${await docRes.text()}`);
  }

  const docData = await docRes.json();
  const bodyContent = docData?.body?.content || [];
  const lastEndIndex = bodyContent.length > 0
    ? Number(bodyContent[bodyContent.length - 1]?.endIndex || 1)
    : 1;

  // Step 1: Delete existing content and insert new text
  const requests: any[] = [];
  if (lastEndIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: lastEndIndex - 1 },
      },
    });
  }

  requests.push({
    insertText: {
      location: { index: 1 },
      text: normalizedContent,
    },
  });

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!updateRes.ok) {
    throw new Error(`Docs batchUpdate failed (${updateRes.status}): ${await updateRes.text()}`);
  }

  // Step 2: Apply formatting (headings + bold labels)
  try {
    // Read authoritative length after insert to avoid out-of-range formatting requests
    let segmentEndIndex = normalizedContent.length + 1;
    const refreshedDocRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (refreshedDocRes.ok) {
      const refreshedDoc = await refreshedDocRes.json();
      const refreshedBody = refreshedDoc?.body?.content || [];
      segmentEndIndex = refreshedBody.length > 0
        ? Number(refreshedBody[refreshedBody.length - 1]?.endIndex || segmentEndIndex)
        : segmentEndIndex;
    }

    const clampRange = (startIndex: number, endIndex: number) => {
      const safeStart = Math.max(1, Math.min(startIndex, segmentEndIndex - 1));
      const safeEnd = Math.max(safeStart + 1, Math.min(endIndex, segmentEndIndex));
      if (safeStart >= segmentEndIndex || safeEnd <= safeStart) return null;
      return { startIndex: safeStart, endIndex: safeEnd };
    };

    const lines = normalizedContent.split("\n");
    const formatRequests: any[] = [];
    let charIndex = 1; // Docs API uses 1-based index

    // Labels that should be bold (the label part before the value)
    const BOLD_LABELS = [
      "ID:", "Jméno:", "Věk:", "Pohlaví:", "Jazyk:", "Typ:", "Klastr:",
      "Status:", "Historický kontext", "Historický kontext:", "Datum", "Událost",
      "Co se dělo", "Stabilizační opatření", "Další krok",
      "Co bylo navrženo", "Výsledek", "Hodnocení",
      "Období", "Aktivita", "Poznámka",
      "Cíl:", "Vhodné nyní:", "Postup:", "Proč funguje:", "Zdroj:", "Obtížnost:",
      "Metoda:", "Termín:", "Poznámky:", "Jádrové přesvědčení",
      "Ochranný mechanismus:", "Vzorce chování:",
      "Doporučený směr:", "Hypotéza:",
    ];

    for (const line of lines) {
      const lineLen = line.length;
      if (lineLen > 0) {
        // Main card title (═══ KARTA ČÁSTI: ...)
        if (/^═*\s*KARTA\s+[ČC]ÁSTI/i.test(line)) {
          const range = clampRange(charIndex, charIndex + lineLen);
          if (range) {
            formatRequests.push({
              updateParagraphStyle: {
                range,
                paragraphStyle: { namedStyleType: "HEADING_1" },
                fields: "namedStyleType",
              },
            });
          }
        }
        // Section headers (═══ SEKCE A – ...)
        else if (/^═*\s*SEKCE\s+[A-M]\s*[–\-:]/i.test(line)) {
          const range = clampRange(charIndex, charIndex + lineLen);
          if (range) {
            formatRequests.push({
              updateParagraphStyle: {
                range,
                paragraphStyle: { namedStyleType: "HEADING_2" },
                fields: "namedStyleType",
              },
            });
          }
        }
        // Sub-headers
        else if (/^(⚠️|Základní identita|Senzorické kotvy|Triggery|Co ho uklidňuje|Vztahy|Povědomí|Hlavní potřeby|Hlavní strachy|Rizika probuzení|Typické konflikty|Principy práce|Kontraindikace|Aktuální stav|Bezpečnostní pravidla|Situační karta|NAVAZUJÍCÍ DOKUMENTY)/i.test(line)) {
          const range = clampRange(charIndex, charIndex + lineLen);
          if (range) {
            formatRequests.push({
              updateParagraphStyle: {
                range,
                paragraphStyle: { namedStyleType: "HEADING_3" },
                fields: "namedStyleType",
              },
            });
          }
        }
        // Thin dividers and analysis labels
        else if (/^(─+|KONTEXT:|KLÍČOVÉ TÉMA|EMOCE TERAPEUTA|PŘENOS|RIZIKA:|KOMPLEXNÍ ANALÝZA|PRŮBĚH SUPERVIZE|DOPORUČENÉ METODY|HODNOCENÍ RIZIK|HLASOVÁ ANALÝZA|POZNÁMKY:|UPOZORNĚNÍ KARLA)/i.test(line)) {
          const range = clampRange(charIndex, charIndex + lineLen);
          if (range) {
            formatRequests.push({
              updateParagraphStyle: {
                range,
                paragraphStyle: { namedStyleType: "HEADING_3" },
                fields: "namedStyleType",
              },
            });
          }
        }

        // Bold labels: support optional bullet prefix (* / • / -)
        const trimmedLine = line.trimStart();
        const leadingSpaces = line.length - trimmedLine.length;
        const bulletPrefixMatch = trimmedLine.match(/^([*•\-]\s+)/);
        const bulletPrefixLen = bulletPrefixMatch ? bulletPrefixMatch[1].length : 0;
        const labelLine = bulletPrefixLen > 0 ? trimmedLine.slice(bulletPrefixLen) : trimmedLine;

        for (const label of BOLD_LABELS) {
          if (labelLine.startsWith(label)) {
            const boldStart = charIndex + leadingSpaces + bulletPrefixLen;
            const boldEnd = boldStart + label.length;
            const range = clampRange(boldStart, boldEnd);
            if (range) {
              formatRequests.push({
                updateTextStyle: {
                  range,
                  textStyle: { bold: true },
                  fields: "bold",
                },
              });
            }
            break;
          }
        }

        // Also bold lines starting with ► (task items)
        if (trimmedLine.startsWith("►")) {
          const boldStart = charIndex + leadingSpaces;
          const colonIdx = trimmedLine.indexOf("[");
          const boldEnd = colonIdx > 0 ? boldStart + colonIdx : boldStart + Math.min(lineLen, 60);
          const range = clampRange(boldStart, boldEnd);
          if (range) {
            formatRequests.push({
              updateTextStyle: {
                range,
                textStyle: { bold: true },
                fields: "bold",
              },
            });
          }
        }
      }
      charIndex += lineLen + 1;
    }

    if (formatRequests.length > 0) {
      // Google Docs API has a limit; batch in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < formatRequests.length; i += CHUNK) {
        const chunk = formatRequests.slice(i, i + CHUNK);
        const fmtRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requests: chunk }),
        });
        if (!fmtRes.ok) {
          console.warn(`[updateGoogleDocInPlace] Formatting chunk failed (non-fatal): ${await fmtRes.text()}`);
        } else {
          console.log(`[updateGoogleDocInPlace] Applied ${chunk.length} format styles (chunk ${Math.floor(i / CHUNK) + 1})`);
        }
      }
    }
  } catch (fmtErr) {
    console.warn(`[updateGoogleDocInPlace] Formatting error (non-fatal): ${fmtErr}`);
  }
}

async function updateFileById(token: string, fileId: string, content: string, mimeType?: string): Promise<any> {
  if (mimeType === DRIVE_DOC_MIME) {
    // Try Docs API first, fallback to Drive multipart with MIME conversion
    try {
      await updateGoogleDocInPlace(token, fileId, content);
      return { id: fileId, updatedInPlace: true };
    } catch (e) {
      console.warn(`[updateFileById] Docs API failed for ${fileId}, falling back to Drive PATCH: ${e}`);
      // Fallback: use Drive API multipart upload to overwrite Google Doc content
      const boundary = "----DIDCycleBoundary";
      const metadata = JSON.stringify({ mimeType: DRIVE_DOC_MIME });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!res.ok) throw new Error(`Drive PATCH (gdoc fallback) failed: ${await res.text()}`);
      return await res.json();
    }
  }

  // For plain text files: multipart upload
  const boundary = "----DIDCycleBoundary";
  const metadata = JSON.stringify({});
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed: ${await res.text()}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----DIDCycleBoundary";
  // Create as Google Doc (not .txt) by specifying mimeType in metadata
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
  const result = await res.json();
  // Apply formatting (Heading 1/2, bold labels) to the new Google Doc
  try {
    await updateGoogleDocInPlace(token, result.id, content);
    console.log(`[createFileInFolder] ✅ Created & formatted Google Doc: ${fileName}`);
  } catch (fmtErr) {
    console.warn(`[createFileInFolder] Created but formatting failed (non-fatal): ${fmtErr}`);
  }
  return result;
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
  return `SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]}`;
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
  // Strip ══ decorators from preamble
  const preamble = (sections["_preamble"] || `KARTA ČÁSTI: ${partName.toUpperCase()}`)
    .replace(/[═]+/g, "").trim();
  lines.push(preamble);
  lines.push("");
  for (const letter of SECTION_ORDER) {
    lines.push(sectionHeader(letter));
    // Strip ══ decorators from section content
    const content = (sections[letter] || "(zatím prázdné)").replace(/[═]+/g, "").trim();
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n");
}

interface CardFileResult { fileId: string; fileName: string; content: string; parentFolderId: string; mimeType?: string; }

type DriveFile = { id: string; name: string; mimeType?: string };

interface RegistryEntry {
  id: string;
  name: string;
  age: string;
  status: string;
  cluster: string;
  note: string;
  normalizedName: string;
}

interface RegistryContext {
  entries: RegistryEntry[];
  activeFolderId: string | null;
  archiveFolderId: string | null;
  sourceFileName: string | null;
  registryFileId: string | null;
  registrySheetName: string | null;
}

interface CardTargetResolution {
  searchRootId: string;
  allowCreate: boolean;
  pathLabel: string;
  registryEntry: RegistryEntry | null;
}

function parseRegistryEntries(rows: string[][]): RegistryEntry[] {
  const nonEmptyRows = rows.filter((row) => row.some((cell) => `${cell ?? ""}`.trim().length > 0));
  if (nonEmptyRows.length === 0) return [];

  let headerRowIndex = nonEmptyRows.findIndex((row, idx) => {
    if (idx > 10) return false;
    const normalized = row.map((c) => canonicalText(String(c)));
    return normalized.some((c) => ["id", "cislo", "number"].some((v) => c.includes(v)))
      && normalized.some((c) => ["jmeno", "nazev", "cast", "part", "fragment"].some((v) => c.includes(v)));
  });
  if (headerRowIndex < 0) headerRowIndex = 0;

  const header = nonEmptyRows[headerRowIndex].map((c) => canonicalText(String(c)));
  const findCol = (hints: string[], fallback: number) => {
    const idx = header.findIndex((h) => hints.some((hint) => h.includes(hint)));
    return idx >= 0 ? idx : fallback;
  };

  const idCol = findCol(["id", "cislo", "number"], 0);
  const nameCol = findCol(["jmeno", "nazev", "cast", "part", "fragment"], 1);
  const ageCol = findCol(["vek", "age"], 2);
  const statusCol = findCol(["stav", "status"], 3);
  const clusterCol = findCol(["klastr", "cluster"], 4);
  const noteCol = findCol(["poznam", "note", "komentar", "role"], 5);

  const entries: RegistryEntry[] = [];
  for (const row of nonEmptyRows.slice(headerRowIndex + 1)) {
    const rawName = String(row[nameCol] ?? "").trim();
    if (!rawName) continue;

    const rawId = String(row[idCol] ?? "").trim();
    const idMatch = rawId.match(/\d{1,4}/);
    const id = idMatch ? idMatch[0].padStart(3, "0") : "";

    const normalizedName = canonicalText(rawName);
    if (!normalizedName) continue;

    entries.push({
      id,
      name: rawName,
      age: String(row[ageCol] ?? "").trim(),
      status: String(row[statusCol] ?? "").trim(),
      cluster: String(row[clusterCol] ?? "").trim(),
      note: String(row[noteCol] ?? "").trim(),
      normalizedName,
    });
  }

  return entries;
}

async function readRegistryRows(token: string, file: DriveFile): Promise<string[][]> {
  let workbook: XLSX.WorkBook;

  if (file.mimeType === DRIVE_SHEET_MIME) {
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Registry export failed (${exportRes.status})`);
    const csvText = await exportRes.text();
    workbook = XLSX.read(csvText, { type: "string" });
  } else {
    const mediaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!mediaRes.ok) throw new Error(`Registry download failed (${mediaRes.status})`);
    const bytes = new Uint8Array(await mediaRes.arrayBuffer());
    workbook = XLSX.read(bytes, { type: "array" });
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][];
  return rawRows.map((row) => row.map((cell) => `${cell ?? ""}`.trim()));
}

function isArchivedFromRegistry(entry: RegistryEntry): boolean {
  const statusCanonical = canonicalText(entry.status || "");
  const combined = canonicalText(`${entry.status} ${entry.cluster} ${entry.note}`);

  // Primárně respektuj explicitní stav ve sloupci "stav/status"
  const archivedStatus = /^(spi|spic|spis|sleep|dormant|archiv|neaktiv|usp|hibern)/;
  const activeStatus = /^(aktiv|active|probuzen|awake|online)/;

  if (archivedStatus.test(statusCanonical)) return true;
  if (activeStatus.test(statusCanonical)) return false;

  // Fallback: pokud je stav nejednoznačný, použij i klastr/poznámku
  const archivedHints = /(spic|spis|spi|sleep|dormant|archiv|neaktiv|uspany|uspavana)/;
  const activeHints = /(aktiv|active|probuzen|awake|online)/;

  if (archivedHints.test(combined)) return true;
  if (activeHints.test(combined)) return false;

  return false;
}

function findBestRegistryEntry(partName: string, entries: RegistryEntry[]): RegistryEntry | null {
  const canonicalPart = canonicalText(partName);
  if (!canonicalPart) return null;

  const scored = entries
    .map((entry) => {
      const score = scoreNameMatch(canonicalPart, entry.normalizedName);
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.entry || null;
}

async function findBestPartFolder(token: string, stateFolderId: string, entry: RegistryEntry): Promise<DriveFile | null> {
  const files = await listFilesInFolder(token, stateFolderId);
  const folders = files.filter((f) => f.mimeType === DRIVE_FOLDER_MIME);

  const idPrefixRegex = entry.id ? new RegExp(`^0*${Number(entry.id)}(?:[_\\s-]|$)`) : null;

  const scored = folders
    .map((folder) => {
      const folderCanonical = canonicalText(folder.name);
      let score = scoreNameMatch(entry.normalizedName, folderCanonical);
      if (idPrefixRegex && idPrefixRegex.test(folder.name)) score += 8;
      if (entry.id && folderCanonical.includes(entry.id)) score += 2;
      return { folder, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.folder || null;
}

// Find a card FILE (not folder) directly in a parent folder – for archives where cards aren't in subfolders
async function findBestPartFile(token: string, parentFolderId: string, entry: RegistryEntry): Promise<DriveFile | null> {
  const files = await listFilesInFolder(token, parentFolderId);
  const nonFolders = files.filter((f) => f.mimeType !== DRIVE_FOLDER_MIME);

  const idPrefixRegex = entry.id ? new RegExp(`^0*${Number(entry.id)}(?:[_\\s-]|$)`) : null;

  const scored = nonFolders
    .map((file) => {
      const fileCanonical = canonicalText(file.name);
      let score = scoreNameMatch(entry.normalizedName, fileCanonical);
      if (idPrefixRegex && idPrefixRegex.test(file.name)) score += 8;
      if (entry.id && fileCanonical.includes(entry.id)) score += 2;
      return { file, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.file || null;
}

async function loadRegistryContext(token: string, rootFolderId: string): Promise<RegistryContext> {
  const rootChildren = await listFilesInFolder(token, rootFolderId);
  const rootFolders = rootChildren.filter((f) => f.mimeType === DRIVE_FOLDER_MIME);

  const pickRootFolder = (predicate: (folderNameCanonical: string, rawName: string) => boolean): string | null => {
    const match = rootFolders.find((f) => predicate(canonicalText(f.name), f.name));
    return match?.id || null;
  };

  const centerFolderId = pickRootFolder((canonical, raw) => /^00/.test(raw.trim()) || canonical.includes("centrum"));
  const activeFolderId = pickRootFolder((canonical, raw) => /^01/.test(raw.trim()) || canonical.includes("aktiv"));
  const archiveFolderId = pickRootFolder((canonical, raw) => /^03/.test(raw.trim()) || (canonical.includes("archiv") && /spic|spis/.test(canonical)));

  if (!centerFolderId) {
    console.warn("[registry] 00_CENTRUM folder not found");
    return { entries: [], activeFolderId, archiveFolderId, sourceFileName: null, registryFileId: null, registrySheetName: null };
  }

  const centerFiles = await listFilesInFolder(token, centerFolderId);
  const registryCandidates = centerFiles
    .filter((f) => {
      const lower = f.name.toLowerCase();
      return f.mimeType === DRIVE_SHEET_MIME || XLS_MIME_TYPES.has(f.mimeType || "") || /\.xlsx?$/.test(lower);
    })
    .map((file) => {
      const canonical = canonicalText(file.name);
      let score = 0;
      if (canonical.includes("01indexvsechcasti")) score += 10;
      else if (canonical.includes("indexvsechcasti")) score += 7;
      else if (canonical.includes("index") && canonical.includes("cast")) score += 4;
      if (file.mimeType === DRIVE_SHEET_MIME) score += 1;
      return { file, score };
    })
    .sort((a, b) => b.score - a.score);

  const registryFile = registryCandidates[0]?.file;
  if (!registryFile) {
    console.warn("[registry] Registry spreadsheet not found in 00_CENTRUM");
    return { entries: [], activeFolderId, archiveFolderId, sourceFileName: null, registryFileId: null, registrySheetName: null };
  }

  const rows = await readRegistryRows(token, registryFile);
  const entries = parseRegistryEntries(rows);
  console.log(`[registry] Loaded ${entries.length} entries from ${registryFile.name}`);

  // Get actual sheet name for Sheets API operations
  let registrySheetName = "Sheet1";
  if (registryFile.mimeType === DRIVE_SHEET_MIME) {
    try {
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}?fields=sheets.properties.title`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        registrySheetName = metaData.sheets?.[0]?.properties?.title || "Sheet1";
      }
    } catch {}
  }

  return {
    entries,
    activeFolderId,
    archiveFolderId,
    sourceFileName: registryFile.name,
    registryFileId: registryFile.id,
    registrySheetName,
  };
}

async function moveFileToFolder(token: string, fileId: string, newParentId: string, oldParentId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${oldParentId}&supportsAllDrives=true`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(`Move file failed (${res.status}): ${await res.text()}`);
}

async function moveFolderToParent(token: string, folderId: string, newParentId: string, oldParentId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${folderId}?addParents=${newParentId}&removeParents=${oldParentId}&supportsAllDrives=true`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(`Move folder failed (${res.status}): ${await res.text()}`);
}

type CardActionType = "aktualizace" | "nova_karta" | "probuzeni_z_archivu";

// ═══ REGISTRY STATUS UPDATE: Change part status in the XLS/Google Sheet ═══
async function updateRegistryStatus(token: string, registryContext: RegistryContext, entry: RegistryEntry, newStatus: string): Promise<boolean> {
  if (!registryContext.sourceFileName) return false;

  // Find the registry file in 00_CENTRUM
  const rootFolderId = registryContext.activeFolderId; // We need root folder
  // Re-find the registry file
  const rootChildren = await listFilesInFolder(token, rootFolderId!).catch(() => []);
  // We need to search from the KARTOTEKA_DID root, not from activeFolderId
  // Let's find 00_CENTRUM and the registry file within it

  // Actually, we already have registryContext which was loaded. We need the file ID.
  // Let's search for the registry file by name across the root.
  const kartotekaId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
  if (!kartotekaId) return false;

  const allRootChildren = await listFilesInFolder(token, kartotekaId);
  const centerFolder = allRootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^00/.test(f.name.trim()) || canonicalText(f.name).includes("centrum")));
  if (!centerFolder) return false;

  const centerFiles = await listFilesInFolder(token, centerFolder.id);
  const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
  const registryFile = centerFiles.find(f => f.mimeType === SHEET_MIME && canonicalText(f.name).includes("index"));

  if (!registryFile) {
    console.warn("[updateRegistryStatus] Registry spreadsheet not found");
    return false;
  }

  try {
    // Get actual sheet name via Sheets API (CSV export returns "Sheet1" which may be wrong)
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    let actualSheetName = "Sheet1";
    if (metaRes.ok) {
      const metaData = await metaRes.json();
      actualSheetName = metaData.sheets?.[0]?.properties?.title || "Sheet1";
      console.log(`[updateRegistryStatus] Actual sheet name: "${actualSheetName}"`);
    }

    // Read current spreadsheet to find the row
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) return false;
    const csvText = await exportRes.text();
    const workbook = XLSX.read(csvText, { type: "string" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return false;

    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][];

    // Find the header row and status column
    const headerRowIndex = rawRows.findIndex((row, idx) => {
      if (idx > 10) return false;
      const normalized = row.map((c: any) => canonicalText(String(c)));
      return normalized.some(c => ["id", "cislo", "number"].some(v => c.includes(v)))
        && normalized.some(c => ["jmeno", "nazev", "cast", "part", "fragment"].some(v => c.includes(v)));
    });
    if (headerRowIndex < 0) return false;

    const header = rawRows[headerRowIndex].map((c: any) => canonicalText(String(c)));
    const statusColIdx = header.findIndex(h => ["stav", "status"].some(hint => h.includes(hint)));
    if (statusColIdx < 0) return false;

    // Find the row for this entry by name match
    const entryCanonical = canonicalText(entry.name);
    const nameColIdx = header.findIndex(h => ["jmeno", "nazev", "cast", "part", "fragment"].some(hint => h.includes(hint)));
    let targetRowIdx = -1;
    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
      const rowName = canonicalText(String(rawRows[i][nameColIdx] ?? ""));
      if (rowName === entryCanonical || scoreNameMatch(rowName, entryCanonical) >= 7) {
        targetRowIdx = i;
        break;
      }
    }
    if (targetRowIdx < 0) return false;

    // Use Google Sheets API to update the specific cell
    // Convert column index to letter (A, B, C, ...)
    const colLetter = String.fromCharCode(65 + statusColIdx);
    // Use actual sheet name from Sheets API, not from CSV parse
    const escapedSheet = `'${actualSheetName.replace(/'/g, "''")}'`;
    const cellRange = `${escapedSheet}!${colLetter}${targetRowIdx + 1}`;

    const updateRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          range: cellRange,
          majorDimension: "ROWS",
          values: [[newStatus]],
        }),
      }
    );

    if (updateRes.ok) {
      console.log(`[updateRegistryStatus] ✅ Updated "${entry.name}" status to "${newStatus}" in cell ${cellRange}`);
      return true;
    } else {
      const errText = await updateRes.text();
      console.error(`[updateRegistryStatus] ❌ Sheets API error: ${errText}`);
      return false;
    }
  } catch (e) {
    console.error(`[updateRegistryStatus] Failed:`, e);
    return false;
  }
}

// ═══ AUTO-INCREMENT ID: Find next available ID from registry ═══
function getNextRegistryId(entries: RegistryEntry[]): number {
  let maxId = 0;
  for (const e of entries) {
    const num = parseInt(e.id, 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  }
  return maxId + 1;
}

// ═══ EXTRACT METADATA FROM CARD CONTENT (Section A) ═══
function extractCardMetadata(cardContent: string): { age: string; cluster: string; role: string } {
  const sections = parseCardSections(cardContent);
  const sectionA = sections["A"] || "";
  const sectionB = sections["B"] || "";
  const allText = `${sectionA}\n${sectionB}`;

  // Extract age: look for "Věk:" pattern
  let age = "";
  const ageMatch = allText.match(/V[ěe]k\s*:\s*([^\n,]+)/i);
  if (ageMatch) age = ageMatch[1].trim();

  // Extract cluster/group: look for "Klastr:", "Skupina:", "Typ:" pattern
  let cluster = "";
  const clusterMatch = allText.match(/(?:Klastr|Skupina|Typ)\s*:\s*([^\n,]+)/i);
  if (clusterMatch) cluster = clusterMatch[1].trim();

  // Extract role: look for role/function description in section A or B
  let role = "";
  const roleMatch = allText.match(/(?:Role|Funkce|Úloha)\s*:\s*([^\n]+)/i);
  if (roleMatch) role = roleMatch[1].trim();
  // Fallback: use first meaningful line from section A as short note
  if (!role && sectionA) {
    const lines = sectionA.split("\n").filter(l => l.trim() && !l.startsWith("[") && !/^(zatím|prázdné|\()/i.test(l.trim()));
    if (lines.length > 0) {
      role = lines[0].trim().slice(0, 80);
    }
  }

  return { age, cluster, role };
}

// ═══ ADD NEW ROW TO REGISTRY SPREADSHEET ═══
async function addRegistryRow(
  token: string,
  registryFileId: string,
  sheetName: string,
  id: string,
  name: string,
  status: string = "Aktivní",
  age: string = "",
  cluster: string = "",
  note: string = ""
): Promise<boolean> {
  try {
    const escapedSheet = `'${sheetName.replace(/'/g, "''")}'`;
    const range = `${escapedSheet}!A:F`;
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${registryFileId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          values: [[id, name, age, status, cluster, note]],
        }),
      }
    );
    if (res.ok) {
      console.log(`[addRegistryRow] ✅ Added row: ID=${id}, Name=${name}, Age=${age}, Status=${status}, Cluster=${cluster}, Note=${note}`);
      return true;
    } else {
      const errText = await res.text();
      console.error(`[addRegistryRow] ❌ Sheets API error: ${errText}`);
      return false;
    }
  } catch (e) {
    console.error(`[addRegistryRow] Failed:`, e);
    return false;
  }
}


async function performImmediateAwakeningUpdates(
  token: string,
  fileId: string,
  fileMimeType: string | undefined,
  partName: string,
  registryContext: RegistryContext,
  entry: RegistryEntry,
): Promise<{ cardUpdated: boolean; registryUpdated: boolean }> {
  const dateStr = new Date().toISOString().slice(0, 10);
  let cardUpdated = false;
  let registryUpdated = false;

  // 1) Read current card content and update sections E, G, K, L
  try {
    const content = await readFileContent(token, fileId);
    const sections = parseCardSections(content);

    // ── SECTION A: Update Status field from "💤 Spí" to "Aktivní" ──
    if (sections["A"]) {
      sections["A"] = sections["A"].replace(
        /Status:\s*💤\s*Spí[^\n]*/i,
        `Status: ✅ Aktivní – probuzení ${dateStr}, komunikuje s Karlem`
      );
    }

    // ── SECTION E: Change "Aktuální stav" from sleeping to active + add chronological entry ──
    const sectionE = sections["E"] || "";
    // Replace the sleeping status line
    const updatedE = sectionE.replace(
      /(?:Aktuální stav\s*\n?)?\s*💤\s*Spí[^\n]*/i,
      `Aktuální stav\n✅ Aktivní – komunikuje s Karlem od ${dateStr}.`
    );
    // Add chronological row
    sections["E"] = updatedE + `\n\n${dateStr}\tProbuzení – část komunikovala s Karlem. Přesunuto z 03_ARCHIV do 01_AKTIVNI.`;

    // ── SECTION G: Add diary row ──
    const sectionG = sections["G"] || "";
    const gRow = `\n${dateStr}\tProbuzení – první kontakt po archivaci\tRozhovor s Karlem\tSledovat stabilitu, pokračovat v komunikaci`;
    sections["G"] = sectionG.includes("(zatím prázdné)")
      ? sectionG.replace("(zatím prázdné)", gRow.trim())
      : sectionG + gRow;

    // ── SECTION K: Add output row ──
    const sectionK = sections["K"] || "";
    const kRow = `\n${dateStr}\tPrvní rozhovor po probuzení z archivu\tProbíhá\tČekáme na další sezení`;
    sections["K"] = sectionK.includes("(zatím prázdné)")
      ? sectionK.replace("(zatím prázdné)", kRow.trim())
      : sectionK + kRow;

    // ── SECTION L: Add activity row ──
    const sectionL = sections["L"] || "";
    const lRow = `\n${dateStr}\tProbuzení – komunikace s Karlem\tPřesunuto z 03_ARCHIV do 01_AKTIVNI`;
    sections["L"] = sectionL + lRow;

    // Rebuild and write
    const resolvedName = entry.name || partName;
    const fullCard = buildCard(resolvedName, sections);
    await updateFileById(token, fileId, fullCard, fileMimeType);
    console.log(`[PROBUZENÍ] ✅ Karta "${resolvedName}" programaticky aktualizována (sekce A, E, G, K, L)`);
    cardUpdated = true;
  } catch (e) {
    console.error(`[PROBUZENÍ] ❌ Aktualizace obsahu karty selhala:`, e);
  }

  // 2) Update registry spreadsheet status
  try {
    registryUpdated = await updateRegistryStatus(token, registryContext, entry, "Aktivní");
    if (registryUpdated) {
      console.log(`[PROBUZENÍ] ✅ Registry status změněn na "Aktivní" pro "${entry.name}"`);
    }
  } catch (e) {
    console.error(`[PROBUZENÍ] ❌ Aktualizace registru selhala:`, e);
  }

  return { cardUpdated, registryUpdated };
}

async function resolveCardTarget(
  token: string,
  rootFolderId: string,
  partName: string,
  registryContext: RegistryContext | null
): Promise<CardTargetResolution & { actionType: CardActionType; awakeningDone?: boolean }> {
  const entry = registryContext ? findBestRegistryEntry(partName, registryContext.entries) : null;

  if (!registryContext) {
    return {
      searchRootId: rootFolderId,
      allowCreate: false,
      pathLabel: "fallback:root",
      registryEntry: null,
      actionType: "aktualizace",
    };
  }

  // Nová část mimo registr: povol vytvoření pouze v aktivní větvi
  if (!entry) {
    const newPartRoot = registryContext.activeFolderId || rootFolderId;
    return {
      searchRootId: newPartRoot,
      allowCreate: true,
      pathLabel: registryContext.activeFolderId
        ? "01_AKTIVNI_FRAGMENTY/(nová část mimo registr)"
        : "fallback:root/(nová část mimo registr)",
      registryEntry: null,
      actionType: "nova_karta",
    };
  }

  const shouldUseArchive = isArchivedFromRegistry(entry);
  
  // ═══ PROBUZENÍ Z ARCHIVU: Pokud je část archivovaná ale komunikuje, přesuň ji ═══
  if (shouldUseArchive && registryContext.archiveFolderId && registryContext.activeFolderId) {
    console.log(`[PROBUZENÍ] 🔄 Část "${entry.name}" je v archivu ale komunikuje – hledám kartu v archivu pro přesun...`);
    
    // 1) Zkus najít podsložku části v archivu
    const partFolder = await findBestPartFolder(token, registryContext.archiveFolderId, entry);
    
    if (partFolder) {
      try {
        await moveFolderToParent(token, partFolder.id, registryContext.activeFolderId, registryContext.archiveFolderId);
        console.log(`[PROBUZENÍ] ✅ Složka "${partFolder.name}" přesunuta z 03_ARCHIV do 01_AKTIVNI`);
      } catch (e) {
        console.error(`[PROBUZENÍ] ❌ Přesun složky selhal:`, e);
      }

      // Find the card file inside the moved folder and update it immediately
      const cardInFolder = await findCardFile(token, entry.name || partName, partFolder.id);
      let awakeningDone = false;
      if (cardInFolder) {
        const result = await performImmediateAwakeningUpdates(token, cardInFolder.fileId, cardInFolder.mimeType, partName, registryContext, entry);
        awakeningDone = result.cardUpdated;
      }
      
      return {
        searchRootId: partFolder.id,
        allowCreate: false,
        pathLabel: `01_AKTIVNI_FRAGMENTY/${partFolder.name} (přesunuto z archivu)`,
        registryEntry: entry,
        actionType: "probuzeni_z_archivu",
        awakeningDone,
      };
    }
    
    // 2) Složka nenalezena – zkus najít soubor (kartu) přímo v archivu
    const partFile = await findBestPartFile(token, registryContext.archiveFolderId, entry);
    
    if (partFile) {
      console.log(`[PROBUZENÍ] 📄 Nalezen soubor "${partFile.name}" přímo v archivu – přesouvám do aktivních...`);
      try {
        await moveFileToFolder(token, partFile.id, registryContext.activeFolderId, registryContext.archiveFolderId);
        console.log(`[PROBUZENÍ] ✅ Soubor "${partFile.name}" přesunut z 03_ARCHIV do 01_AKTIVNI`);
      } catch (e) {
        console.error(`[PROBUZENÍ] ❌ Přesun souboru selhal:`, e);
      }

      // Immediately update the card content + registry
      const result = await performImmediateAwakeningUpdates(token, partFile.id, partFile.mimeType, partName, registryContext, entry);
      
      return {
        searchRootId: registryContext.activeFolderId,
        allowCreate: false,
        pathLabel: `01_AKTIVNI_FRAGMENTY/${partFile.name} (přesunuto z archivu)`,
        registryEntry: entry,
        actionType: "probuzeni_z_archivu",
        awakeningDone: result.cardUpdated,
      };
    }
    
    // 3) Nic nenalezeno v archivu – zkus aktivní složku
    console.warn(`[PROBUZENÍ] Část "${entry.name}" nenalezena v archivu (ani složka, ani soubor), zkouším aktivní...`);
  }

  const stateFolderId = shouldUseArchive ? registryContext.archiveFolderId : registryContext.activeFolderId;

  if (!stateFolderId) {
    throw new Error(`Registry matched "${entry.name}", but state folder is missing (${shouldUseArchive ? "archive" : "active"})`);
  }

  const partFolder = await findBestPartFolder(token, stateFolderId, entry);
  const searchRootId = partFolder?.id || stateFolderId;
  const pathLabel = shouldUseArchive
    ? `03_ARCHIV_SPICICH/${partFolder?.name || "(bez podsložky)"}`
    : `01_AKTIVNI_FRAGMENTY/${partFolder?.name || "(bez podsložky)"}`;

  return {
    searchRootId,
    allowCreate: false,
    pathLabel,
    registryEntry: entry,
    actionType: "aktualizace",
  };
}

async function findCardFile(token: string, partName: string, rootFolderId: string): Promise<CardFileResult | null> {
  const normalizedPart = canonicalText(partName);

  async function searchFolder(folderId: string): Promise<CardFileResult | null> {
    const files = await listFilesInFolder(token, folderId);

    // Collect all matching files, prefer ORIGINAL Google Docs over companion .txt
    const matches: Array<{ file: typeof files[0]; priority: number }> = [];
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER_MIME) continue;
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      const normalizedFileName = canonicalText(baseName);
      if (scoreNameMatch(normalizedPart, normalizedFileName) > 0) {
        // Google Docs (originals) get priority 0 (best), .txt companions created by migration get priority 2
        const isKartaTxt = /^karta_/i.test(f.name) && /\.txt$/i.test(f.name);
        const priority = f.mimeType === DRIVE_DOC_MIME ? 0 : isKartaTxt ? 2 : 1;
        matches.push({ file: f, priority });
      }
    }

    // Sort by priority (prefer original Google Docs)
    matches.sort((a, b) => a.priority - b.priority);

    for (const { file: f } of matches) {
      try {
        const content = await readFileContent(token, f.id);
        console.log(`[findCardFile] Found "${partName}": ${f.name} (${f.id}) mimeType=${f.mimeType} in folder ${folderId}`);
        return { fileId: f.id, fileName: f.name, content, parentFolderId: folderId, mimeType: f.mimeType };
      } catch (e) { console.error(`[findCardFile] Cannot read ${f.name}:`, e); }
    }
    const subfolders = files.filter(f => f.mimeType === DRIVE_FOLDER_MIME);
    for (const sf of subfolders) {
      const result = await searchFolder(sf.id);
      if (result) return result;
    }
    return null;
  }

  return searchFolder(rootFolderId);
}

// Rename a Drive file
async function renameDriveFile(token: string, fileId: string, newName: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    }
  );
  if (!res.ok) console.warn(`[renameDriveFile] Failed to rename ${fileId} to ${newName}: ${res.status}`);
  else console.log(`[renameDriveFile] ✅ Renamed to: ${newName}`);
}

// Update card sections in-place by file ID
async function updateCardSections(
  token: string,
  partName: string,
  newSections: Record<string, string>,
  folderId: string,
  options?: { allowCreate?: boolean; searchName?: string; canonicalPartName?: string; registryContext?: RegistryContext | null }
): Promise<{ fileName: string; sectionsUpdated: string[]; isNew: boolean }> {
  const allowCreate = options?.allowCreate ?? false;
  const searchName = options?.searchName || partName;
  const canonicalPartName = options?.canonicalPartName || partName;
  const rc = options?.registryContext;
  const card = await findCardFile(token, searchName, folderId);
  const dateStr = new Date().toISOString().slice(0, 10);
  let existingSections: Record<string, string>;

  if (card) {
    existingSections = parseCardSections(card.content);
    console.log(`[updateCardSections] Card: ${card.fileName}, existing sections: ${Object.keys(existingSections).filter(k => k !== "_preamble").join(",")}`);

    // ═══ ORPHAN CARD: exists on Drive but NOT in registry → add to registry + rename ═══
    const registryEntry = rc ? findBestRegistryEntry(searchName, rc.entries) : null;
    if (!registryEntry && rc?.registryFileId && rc?.registrySheetName) {
      const nextId = getNextRegistryId(rc.entries);
      const paddedId = String(nextId).padStart(3, "0");
      const normalizedName = canonicalPartName.replace(/\s+/g, "_").toUpperCase();
      const expectedFileName = `${paddedId}_${normalizedName}`;

      // Extract metadata from card content for registry
      const meta = extractCardMetadata(card.content);
      // Add row to registry
      const added = await addRegistryRow(token, rc.registryFileId, rc.registrySheetName, paddedId, canonicalPartName, "Aktivní", meta.age, meta.cluster, meta.role);
      if (added) {
        console.log(`[updateCardSections] ✅ Orphan "${canonicalPartName}" added to registry as ID ${paddedId}`);
        rc.entries.push({
          id: paddedId,
          name: canonicalPartName,
          age: meta.age,
          status: "Aktivní",
          cluster: meta.cluster,
          note: meta.role,
          normalizedName: canonicalText(canonicalPartName),
        });
      }

      // Rename file on Drive to match convention
      if (card.fileName !== expectedFileName) {
        await renameDriveFile(token, card.fileId, expectedFileName);
      }
    }
  } else {
    if (!allowCreate) {
      throw new Error(`Card for "${partName}" not found in resolved location; creation disabled to prevent duplicates.`);
    }
    existingSections = {};
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

  const fullCard = buildCard(canonicalPartName, existingSections);

  if (card) {
    await updateFileById(token, card.fileId, fullCard, card.mimeType);
    return { fileName: card.fileName, sectionsUpdated: updatedKeys, isNew: false };
  }

  // Auto-increment ID from registry and create as Google Doc
  const nextId = getNextRegistryId(rc?.entries || []);
  const paddedId = String(nextId).padStart(3, "0");
  const normalizedName = canonicalPartName.replace(/\s+/g, "_").toUpperCase();
  const newFileName = `${paddedId}_${normalizedName}`;
  await createFileInFolder(token, newFileName, fullCard, folderId);
  // Add new entry to registry spreadsheet
  if (rc?.registryFileId && rc?.registrySheetName) {
    // Extract metadata from the card we just built
    const meta = extractCardMetadata(fullCard);
    const added = await addRegistryRow(token, rc.registryFileId, rc.registrySheetName, paddedId, canonicalPartName, "Aktivní", meta.age, meta.cluster, meta.role);
    if (added) {
      rc.entries.push({
        id: paddedId,
        name: canonicalPartName,
        age: meta.age,
        status: "Aktivní",
        cluster: meta.cluster,
        note: meta.role,
        normalizedName: canonicalText(canonicalPartName),
      });
    }
  }
  console.log(`[updateCardSections] ✅ Created new Google Doc: ${newFileName} (ID: ${paddedId})`);
  return { fileName: newFileName, sectionsUpdated: updatedKeys, isNew: true };
}

function isTextCandidateFile(file: DriveFile): boolean {
  if (file.mimeType === "application/vnd.google-apps.folder") return false;
  if (file.mimeType === DRIVE_SHEET_MIME) return false;
  for (const mime of XLS_MIME_TYPES) { if (file.mimeType === mime) return false; }

  const lower = file.name.toLowerCase();
  // Skip registry/index/instruction files but NOT DID_ card files
  if (lower.startsWith("00_") || lower.startsWith("01_index") || lower.startsWith("02_instrukce") || lower.startsWith("02_klast")) return false;
  if (lower.includes("denni_report") || lower.includes("tydenni_report")) return false;
  if (lower.includes("instrukce") || lower.includes("mapa_vztahu")) return false;

  // Accept Google Docs (DID cards stored as Google Docs)
  if (file.mimeType === DRIVE_DOC_MIME) return true;

  const isTextExtension = /\.(txt|md|doc|docx)$/i.test(file.name);
  return isTextExtension;
}

function looksLikeDidCard(fileName: string, content: string): boolean {
  if (fileName.toLowerCase().startsWith("karta_")) return true;
  if (/^\d{3,}[_-]/i.test(fileName)) return true;
  return /SEKCE\s+[A-M]\s*[–\-:]/i.test(content) || /KARTA\s+ČÁSTI/i.test(content);
}

function partNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(txt|md|doc|docx)$/i, "");
  const withoutKarta = base.replace(/^karta_/i, "");
  const withoutNumericPrefix = withoutKarta.replace(/^\d{3,}[_-]/, "");
  return (withoutNumericPrefix || withoutKarta || base).replace(/_/g, " ").trim();
}

function normalizePartHint(partHint: string): string {
  return partNameFromFileName(partHint || "");
}

interface SuccessfulCardUpdate {
  partName: string;
  fileName: string;
  sectionsUpdated: string[];
  pathLabel: string;
  actionType: CardActionType;
}

interface BlockedCardUpdate {
  partName: string;
  registryId: string;
  pathLabel: string;
  status: string;
  cluster: string;
  pendingSections: string[];
}

function extractAiRecommendations(reportText: string): string {
  if (!reportText) return "";
  const recommendationStart = reportText.search(/\bDoporučen[ií]\b/i);
  if (recommendationStart < 0) return "";
  return reportText.slice(recommendationStart).trim();
}

function buildDeterministicDailyReport(params: {
  successful: SuccessfulCardUpdate[];
  blocked: BlockedCardUpdate[];
  aiRecommendations: string;
}): string {
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  lines.push(`DID denní report (${today})`);
  lines.push("");
  lines.push("Co bylo SKUTEČNĚ zapsáno:");

  if (params.successful.length === 0) {
    lines.push("- Žádná karta nebyla dnes aktualizována.");
  } else {
    for (const item of params.successful) {
      const actionLabel = item.actionType === "nova_karta"
        ? "📝 NOVÁ KARTA ZALOŽENA"
        : item.actionType === "probuzeni_z_archivu"
          ? "🔄 PROBUZENÍ – karta přesunuta z archivu do aktivních"
          : "✏️ Zápis do existující karty";
      lines.push(`- ${item.partName}: ${actionLabel}, sekce ${item.sectionsUpdated.join(", ")} [${item.pathLabel}]`);
    }
  }

  if (params.blocked.length > 0) {
    lines.push("");
    lines.push("Fail-safe blokace (bez zápisu):");
    for (const b of params.blocked) {
      lines.push(`- ${b.partName} (ID ${b.registryId}) nenalezena v ${b.pathLabel}; odloženo: ${b.pendingSections.join(", ")}; stav: ${b.status}; klastr: ${b.cluster}`);
    }
  }

  if (params.aiRecommendations) {
    lines.push("");
    lines.push("Doporučení pro sezení (AI návrh, klinicky ověřit):");
    lines.push(params.aiRecommendations);
  }

  return lines.join("\n").trim();
}

async function listFilesRecursive(token: string, rootFolderId: string): Promise<DriveFile[]> {
  const collected: DriveFile[] = [];
  const stack: string[] = [rootFolderId];

  while (stack.length > 0) {
    const currentFolder = stack.pop()!;
    const files = await listFilesInFolder(token, currentFolder);
    for (const file of files) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        stack.push(file.id);
      } else {
        collected.push(file);
      }
    }
  }

  return collected;
}

async function normalizeCardStructures(token: string, rootFolderId: string, forceReformat = false, targetPart?: string): Promise<string[]> {
  const files = await listFilesRecursive(token, rootFolderId);
  let candidateFiles = files.filter(isTextCandidateFile);
  const normalized: string[] = [];

  // If targetPart specified, filter to only matching files
  if (targetPart) {
    const targetCanonical = canonicalText(targetPart);
    candidateFiles = candidateFiles.filter(f => {
      const fileCanonical = canonicalText(f.name);
      return scoreNameMatch(targetCanonical, fileCanonical) > 0 || fileCanonical.includes(targetCanonical);
    });
    console.log(`[normalizeCardStructures] Targeting "${targetPart}", found ${candidateFiles.length} matching files`);
  }

  for (const file of candidateFiles) {
    try {
      const original = await readFileContent(token, file.id);
      if (!looksLikeDidCard(file.name, original)) continue;

      const rebuilt = buildCard(partNameFromFileName(file.name), parseCardSections(original));
      if (forceReformat || rebuilt.trim() !== original.trim()) {
        await updateFileById(token, file.id, rebuilt, file.mimeType);
        normalized.push(file.name);
        console.log(`[normalizeCardStructures] Reformatted: ${file.name} (mimeType: ${file.mimeType})`);
      }
    } catch (e) {
      console.error(`[normalizeCardStructures] Failed for ${file.name}:`, e);
    }
  }

  return normalized;
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

  // ═══ EMAIL GUARD: Only send report emails from scheduled cron calls ═══
  let requestBody: any = {};
  try { requestBody = await req.clone().json(); } catch {}
  const isCronSource = requestBody?.source === "cron";
  const isTestEmail = requestBody?.testEmail === true;
  const shouldSendEmails = (isCronCall && isCronSource) || isTestEmail;
  if (!shouldSendEmails) {
    console.log("[daily-cycle] Manual invocation – will process cards but NOT send report emails.");
  }

  try {
    // ═══ FAST-PATH: syncRegistry – scan Drive cards, register orphans, rename to ID_NAME ═══
    if (requestBody?.syncRegistry) {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
      if (!folderId) throw new Error("Kartotéka_DID folder not found");
      const rc = await loadRegistryContext(token, folderId);
      if (!rc.activeFolderId) throw new Error("01_AKTIVNI_FRAGMENTY not found");

      // Collect all card files from active + archive folders
      const allCardFiles: Array<{ file: DriveFile; folderId: string; folderLabel: string }> = [];
      for (const [fid, label] of [[rc.activeFolderId, "01_AKTIVNI"], [rc.archiveFolderId, "03_ARCHIV"]] as [string | null, string][]) {
        if (!fid) continue;
        const files = await listFilesRecursive(token, fid);
        for (const f of files) {
          if (isTextCandidateFile(f)) allCardFiles.push({ file: f, folderId: fid, folderLabel: label });
        }
      }

      const results: string[] = [];
      for (const { file, folderLabel } of allCardFiles) {
        // Check if file looks like a DID card
        let content: string;
        try { content = await readFileContent(token, file.id); } catch { continue; }
        if (!looksLikeDidCard(file.name, content)) continue;

        const partName = partNameFromFileName(file.name);
        const entry = findBestRegistryEntry(partName, rc.entries);

        if (entry) {
          // Already registered – check if filename matches convention
          const expectedPrefix = `${entry.id}_`;
          if (!file.name.startsWith(expectedPrefix)) {
            const normalizedName = entry.name.replace(/\s+/g, "_").toUpperCase();
            const expectedFileName = `${entry.id}_${normalizedName}`;
            await renameDriveFile(token, file.id, expectedFileName);
            results.push(`✏️ Přejmenováno: "${file.name}" → "${expectedFileName}" (${folderLabel})`);
          }

          // Update existing row with metadata from card content (age, status→D, cluster, note)
          const meta = extractCardMetadata(content);
          const isArchived = folderLabel === "03_ARCHIV";
          const currentStatus = isArchived ? "Spí" : "Aktivní";
          // Find the row number in the spreadsheet (entry.id is 1-based from registry)
          const rowIndex = rc.entries.indexOf(entry);
          if (rowIndex >= 0 && rc.registryFileId && rc.registrySheetName) {
            // Registry has header row, so data starts at row 2; rowIndex is 0-based
            const sheetRow = rowIndex + 2;
            const escapedSheet = `'${rc.registrySheetName.replace(/'/g, "''")}'`;
            const range = `${escapedSheet}!C${sheetRow}:F${sheetRow}`;
            try {
              const updateRes = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${rc.registryFileId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
                {
                  method: "PUT",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    values: [[meta.age, currentStatus, meta.cluster, meta.role]],
                  }),
                }
              );
              if (updateRes.ok) {
                results.push(`📊 Aktualizován řádek ${sheetRow}: ${entry.name} (Věk=${meta.age || "?"}, Status=${currentStatus}, Klastr=${meta.cluster || "?"}, Role=${meta.role?.slice(0, 40) || "?"})`);
              } else {
                const errText = await updateRes.text();
                console.warn(`[syncRegistry] Row update failed for ${entry.name}: ${errText}`);
                results.push(`⚠️ Nepodařilo se aktualizovat řádek: ${entry.name}`);
              }
            } catch (e) {
              console.warn(`[syncRegistry] Row update error for ${entry.name}:`, e);
            }
          } else {
            results.push(`✅ OK: "${file.name}" (ID ${entry.id}, ${folderLabel})`);
          }
        } else {
          // Orphan – register and rename
          const nextId = getNextRegistryId(rc.entries);
          const paddedId = String(nextId).padStart(3, "0");
          const normalizedName = partName.replace(/\s+/g, "_").toUpperCase();
          const expectedFileName = `${paddedId}_${normalizedName}`;

          if (rc.registryFileId && rc.registrySheetName) {
            // Extract metadata from card content for registry
            const meta = extractCardMetadata(content);
            const added = await addRegistryRow(token, rc.registryFileId, rc.registrySheetName, paddedId, partName, "Aktivní", meta.age, meta.cluster, meta.role);
            if (added) {
              rc.entries.push({ id: paddedId, name: partName, age: meta.age, status: "Aktivní", cluster: meta.cluster, note: meta.role, normalizedName: canonicalText(partName) });
            }
          }
          await renameDriveFile(token, file.id, expectedFileName);
          results.push(`📝 NOVÝ: "${file.name}" → "${expectedFileName}" (ID ${paddedId}, ${folderLabel})`);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Synchronizace registru: ${results.length} karet zkontrolováno`,
        results,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ FAST-PATH: reformat only (no DB, no AI, no email) ═══
    if (requestBody?.reformat) {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
      if (!folderId) throw new Error("Kartotéka_DID folder not found");
      
      // If partName specified, only reformat that one card
      const targetPart = requestBody?.partName as string | undefined;
      const normalizedCardFiles = await normalizeCardStructures(token, folderId, true, targetPart);
      
      return new Response(JSON.stringify({
        success: true,
        message: `Přeformátováno ${normalizedCardFiles.length} karet`,
        reformattedCards: normalizedCardFiles,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. SBĚR DAT
    // For card updates: only unprocessed items
    const { data: unprocessedThreadRows } = await sb.from("did_threads").select("*").eq("is_processed", false);
    const threads = unprocessedThreadRows ?? [];

    const { data: unprocessedConvRows } = await sb.from("did_conversations").select("*").eq("is_processed", false);
    const conversations = unprocessedConvRows ?? [];

    // For daily EMAIL REPORT: ALL threads/conversations from last 24h (including already-processed ones)
    // This prevents "quiet day" false reports when manual updates already processed the data
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: allRecentThreadRows } = await sb.from("did_threads").select("*").gte("last_activity_at", cutoff24h);
    const allRecentThreads = allRecentThreadRows ?? [];
    const { data: allRecentConvRows } = await sb.from("did_conversations").select("*").gte("saved_at", cutoff24h);
    const allRecentConversations = allRecentConvRows ?? [];

    const { data: cycle } = await sb.from("did_update_cycles").insert({ cycle_type: "daily", status: "running" }).select().single();

    // 2. NORMALIZACE STRUKTURY KARET A-M (probíhá vždy)
    const token = await getAccessToken();
    const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");

    let registryContext: RegistryContext | null = null;
    if (folderId) {
      try {
        registryContext = await loadRegistryContext(token, folderId);
        console.log(`[registry] activeFolder=${registryContext.activeFolderId || "N/A"}, archiveFolder=${registryContext.archiveFolderId || "N/A"}, entries=${registryContext.entries.length}`);
      } catch (e) {
        console.error("[registry] Failed to load registry context:", e);
      }
    }

    // Only run full normalization on explicit reformat request, NOT during cron runs
    // (Docs API formatting for all 25+ cards exceeds edge function memory limit)
    const forceReformat = !!requestBody?.reformat;
    const normalizedCardFiles = (forceReformat && folderId) ? await normalizeCardStructures(token, folderId, true) : [];
    const cardsUpdated: string[] = normalizedCardFiles.map(name => `${name} (normalizace A-M)`);
    const successfulCardUpdates: SuccessfulCardUpdate[] = [];
    const blockedCardUpdates: BlockedCardUpdate[] = [];
    let hadCardUpdateErrors = false;
    // Use allRecentThreads for report generation, but threads (unprocessed) for card updates
    const hasRecentActivity = allRecentThreads.length > 0 || allRecentConversations.length > 0;

    if (threads.length === 0 && conversations.length === 0) {
      if (cycle) {
        await sb.from("did_update_cycles").update({
          status: "completed",
          completed_at: new Date().toISOString(),
          report_summary: normalizedCardFiles.length > 0
            ? `Normalizováno ${normalizedCardFiles.length} karet na strukturu A–M.`
            : "No new threads to process (already processed earlier)",
          cards_updated: cardsUpdated,
        }).eq("id", cycle.id);
      }

      // If there IS recent activity (already processed by manual trigger), generate a REAL report, not "quiet day"
      if (shouldSendEmails && hasRecentActivity) {
        console.log(`[report] No unprocessed data, but ${allRecentThreads.length} recent threads + ${allRecentConversations.length} recent convs found. Generating report from recent activity.`);
        // Fall through to the main report generation below instead of returning early
      } else if (shouldSendEmails && !hasRecentActivity) {
        // Truly quiet day - no activity at all in 24h
        try {
          const dateStr = new Date().toISOString().slice(0, 10);

          if (RESEND_API_KEY && LOVABLE_API_KEY) {
            const resend = new Resend(RESEND_API_KEY);

            let hankaHtml = "";
            try {
              const hankaRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: `Jsi Karel – osobní AI asistent rodiny. Vygeneruj krátký denní report pro Haničku (partnerku, láska tisíciletá). Intimní, laskavý tón.
Formát HTML emailu. Dnes nebyla žádná nová aktivita částí ani konverzace. Napiš klidný, uklidňující report:
- Pozdrav Haničku
- Řekni, že dnes byl klidný den, žádné části se neozvaly
- Krátké povzbuzení
- Podpis: Karel` },
                    { role: "user", content: `Datum: ${dateStr}\nDnes nebyla zaznamenána žádná aktivita částí.` },
                  ],
                }),
              });
              if (hankaRes.ok) {
                const d = await hankaRes.json();
                hankaHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
              }
            } catch {}
            if (!hankaHtml) hankaHtml = `<p>Dnes klidný den – žádné části se neozvaly. Karel</p>`;

            let kataHtml = "";
            try {
              const kataRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: `Jsi Karel. Vygeneruj krátký denní report pro Káťu (druhý terapeut). PROFESIONÁLNÍ tón. Dnes nebyla žádná aktivita.
Formát HTML emailu:
- Pozdrav Káťu
- Řekni, že dnes bez aktivity
- Podpis: Karel` },
                    { role: "user", content: `Datum: ${dateStr}\nDnes nebyla zaznamenána žádná aktivita částí.` },
                  ],
                }),
              });
              if (kataRes.ok) {
                const d = await kataRes.json();
                kataHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
              }
            } catch {}
            if (!kataHtml) kataHtml = `<p>Dnes bez aktivity částí. Karel</p>`;

            await resend.emails.send({
              from: "Karel <karel@hana-chlebcova.cz>",
              to: [MAMKA_EMAIL],
              subject: `Karel – denní report ${dateStr}`,
              html: hankaHtml,
            });

            await resend.emails.send({
              from: "Karel <karel@hana-chlebcova.cz>",
              to: [KATA_EMAIL],
              subject: `Karel – report pro Káťu ${dateStr}`,
              html: kataHtml,
            });
          }
        } catch (e) {
          console.error("Quiet-day email error:", e);
        }

        return new Response(JSON.stringify({
          success: true,
          message: "No activity in last 24h, quiet-day report sent",
          threadsProcessed: 0,
          conversationsProcessed: 0,
          cardsUpdated,
          reportSent: shouldSendEmails,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        // No emails needed and no data to process
        return new Response(JSON.stringify({
          success: true,
          message: "No new threads to process",
          threadsProcessed: 0,
          conversationsProcessed: 0,
          cardsUpdated,
          reportSent: false,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // When we reach here with no unprocessed data but hasRecentActivity=true,
    // we need to use allRecentThreads/allRecentConversations for report generation
    // Use allRecentThreads for summaries if threads is empty but recent activity exists
    const reportThreads = threads.length > 0 ? threads : (shouldSendEmails && hasRecentActivity ? allRecentThreads : []);
    const reportConversations = conversations.length > 0 ? conversations : (shouldSendEmails && hasRecentActivity ? allRecentConversations : []);

    // 3. COMPILE THREAD + CONVERSATION DATA (token-safe, truncated)
    const clip = (v: string, max = 600) => (v.length > max ? `${v.slice(0, max)}…` : v);

    const threadSummaries = reportThreads.map(t => {
      const msgs = ((t.messages as any[]) || []).slice(-20);
      
      // ═══ ROLE LABELING: Rozliš kdo mluví podle sub_mode ═══
      const isCastMode = (t.sub_mode || "cast") === "cast";
      const userLabel = isCastMode ? "ČÁST" : "TERAPEUT";
      const modeNote = isCastMode 
        ? "" 
        : `\n⚠️ REŽIM "${t.sub_mode}": Uživatel je TERAPEUT (${t.sub_mode === "mamka" ? "Hanka" : t.sub_mode === "kata" ? "Káťa" : "terapeut"}), NE část! Jakékoli zmínky o částech v tomto rozhovoru jsou jen dotazy/konzultace – NEZNAMENÁ to, že se část probudila nebo je aktivní.`;

      // ═══ SWITCH DETECTION: Detect if part changed mid-thread ═══
      // Find last user message that looks like a self-identification
      let detectedSwitch = "";
      if (isCastMode) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== "user" || typeof m.content !== "string") continue;
          const switchMatch = m.content.match(/(?:jsem|já jsem|tady|i am|i'm|my name is)\s+([A-ZÁ-Ž][a-zá-ž]{1,20})/i);
          if (switchMatch) {
            const detectedName = switchMatch[1].trim();
            const originalName = (t.part_name || "").trim().toLowerCase();
            if (detectedName.toLowerCase() !== originalName) {
              detectedSwitch = detectedName;
            }
            break;
          }
        }
      }
      
      const switchNote = detectedSwitch 
        ? `\n⚠️ SWITCH DETEKOVÁN: Vlákno začalo jako "${t.part_name}" ale část se představila jako "${detectedSwitch}". Přiřaď konverzaci k POSLEDNÍ identifikované části (${detectedSwitch}), NE k původní (${t.part_name}).`
        : "";
      
      return `=== Vlákno: ${t.part_name} (${t.sub_mode}) ===${modeNote}${switchNote}\nJazyk: ${t.part_language}\nZačátek: ${t.started_at}\nPoslední aktivita: ${t.last_activity_at}\nPočet zpráv: ${msgs.length}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? userLabel : "KAREL"}]: ${typeof m.content === "string" ? clip(m.content) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    const convSummaries = reportConversations.map(c => {
      const msgs = ((c.messages as any[]) || []).slice(-20);
      return `=== Konverzace: ${c.sub_mode} (${c.label}) ===\nUloženo: ${c.saved_at}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? "UŽIVATEL" : "KAREL"}]: ${typeof m.content === "string" ? clip(m.content) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    const allSummaries = [threadSummaries, convSummaries].filter(Boolean).join("\n\n=== KONVERZACE Z JINÝCH PODREŽIMŮ ===\n\n");
    const knownThreadParts = new Set(
      reportThreads
        .map((t) => canonicalText(normalizePartHint(t.part_name || "")))
        .filter(Boolean)
    );
    let driveContext = "";
    let existingCards: Record<string, string> = {};
    let instructionContext = "";

    if (folderId) {
      try {
        const partsFileId = await findFile(token, "00_Seznam_casti.txt", folderId);
        if (partsFileId) driveContext = await readFileContent(token, partsFileId);
      } catch (e) { console.error("Drive read error:", e); }

      // Load 02_Instrukce from 00_CENTRUM for context about who is who
      try {
        const centerFolderId = registryContext?.activeFolderId
          ? (await findFolder(token, "00_CENTRUM")) || null
          : null;
        // Try to find instruction document in center folder
        const rootChildren = await listFilesInFolder(token, folderId);
        const centerFolder = rootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^00/.test(f.name.trim()) || canonicalText(f.name).includes("centrum")));
        if (centerFolder) {
          const centerFiles = await listFilesInFolder(token, centerFolder.id);
          const instrFile = centerFiles.find(f => canonicalText(f.name).includes("instrukce"));
          if (instrFile) {
            try {
              const instrContent = await readFileContent(token, instrFile.id);
              // Take first 4000 chars to keep token budget manageable
              instructionContext = instrContent.length > 4000 ? instrContent.slice(0, 4000) + "…" : instrContent;
              console.log(`[daily-cycle] Loaded instruction doc: ${instrFile.name} (${instructionContext.length} chars)`);
            } catch (e) { console.warn(`Failed to read instruction doc:`, e); }
          }
        }
      } catch (e) { console.warn("Failed to load 02_Instrukce:", e); }

      // Load cards only for explicitly named thread parts (fast)
      const threadParts = [...new Set(threads.map(t => normalizePartHint(t.part_name || "").trim()).filter(Boolean))];
      for (const partName of threadParts) {
        try {
          const target = await resolveCardTarget(token, folderId, partName, registryContext);
          const lookupName = target.registryEntry?.name || partName;
          const card = await findCardFile(token, lookupName, target.searchRootId);
          if (card) existingCards[lookupName] = card.content;
        } catch (e) {
          console.error(`[prefetch] Failed to resolve card target for ${partName}:`, e);
        }
      }
      // Cards for parts mentioned in conversations will be found by AI + updateCardSections()
    }

    // 3. AI ANALÝZA – full A-M decomposition
    const existingCardsContext = Object.entries(existingCards).map(([name, content]) =>
      `=== EXISTUJÍCÍ KARTA: ${name} ===\n${content.length > 3000 ? `${content.slice(0, 3000)}…` : content}`
    ).join("\n\n");

    let perplexityContext = "";
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (PERPLEXITY_API_KEY && allSummaries.trim().length > 40) {
      try {
        const perplexityPrompt = allSummaries.length > 7000 ? `${allSummaries.slice(0, 7000)}…` : allSummaries;
        const pRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "sonar-pro",
            messages: [
              {
                role: "system",
                content: "Jsi klinický rešeršista pro DID. Vrať pouze stručné, praktické body: metody, kontraindikace, rizika a odkazy relevantní k dnešním konverzacím. Žádné domýšlení bez zdroje.",
              },
              { role: "user", content: perplexityPrompt },
            ],
            search_mode: "academic",
            search_recency_filter: "year",
          }),
        });

        if (pRes.ok) {
          const pData = await pRes.json();
          const text = pData.choices?.[0]?.message?.content || "";
          const citations: string[] = pData.citations || [];
          if (text) {
            perplexityContext = `\n\n═══ REŠERŠNÍ KONTEXT (Perplexity) ═══\n${text}`;
            if (citations.length > 0) {
              perplexityContext += `\n\nCitace:\n${citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`;
            }
          }
        } else {
          console.warn(`[perplexity] API error ${pRes.status}: ${(await pRes.text()).slice(0, 400)}`);
        }
      } catch (e) {
        console.warn("[perplexity] Rešerše selhala:", e);
      }
    }

    const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – analytik DID systému. Zpracuj data z rozhovorů a rozlož KAŽDOU informaci do správných sekcí karet částí.

═══ KRITICKÉ PRAVIDLO: DETEKCE SWITCHŮ VE VLÁKNECH ═══
⚠️ Pokud je ve vlákně označen SWITCH (např. "vlákno začalo jako Lincoln ale část se představila jako Adam"):
- NEPIŠ kartu pro původní část (Lincoln), ale pro SKUTEČNOU část (Adam)
- Pokud se část pouze PŘEDSTAVILA na začátku a pak se přepnula, celý rozhovor patří NOVÉ části
- V [REPORT] uveď: "Ve vlákně [part_name] došlo ke switchi na [nová_část]"

═══ ZÁKLADNÍ PRAVIDLO ═══
Jeden dokument/konverzace = mnoho informací = každá informace má svou sekci.
NIKDY nevkládej celou konverzaci do jedné sekce. NIKDY nemažeš původní obsah – pouze doplňuješ nebo upřesňuješ.

═══ KRITICKÉ PRAVIDLO: ROZLIŠUJ "ZMÍNĚNO" vs "AKTIVNÍ" ═══
⚠️ Pokud terapeut (Hanka/Káťa) v rozhovoru ZMÍNÍ jméno části (např. "Jak se má Anička?"), to NEZNAMENÁ že se část probudila nebo je aktivní!
- "Zmíněno v rozhovoru" ≠ "Část je aktivní"
- Pouze pokud část SAMA komunikuje (má vlastní zprávy s role "user" v režimu "cast"), je aktivní
- V režimu "kata" nebo "mamka" mluví TERAPEUT, ne části. Jakékoli zmínky o částech jsou jen dotazy/konzultace.

═══ KRITICKÉ PRAVIDLO: BIOLOGICKÉ OSOBY vs DID ČÁSTI ═══
⚠️ Následující osoby NEJSOU části DID systému, jsou to reální lidé. NIKDY pro ně NEVYTVÁŘEJ [KARTA:...] blok:
- Amálka (7 let) – biologická dcera Káti a Jiřího
- Tonička (4 roky) – biologická dcera Káti a Jiřího  
- Jiří – Kátin manžel
- Káťa / Katka / Kája – druhý terapeut, Hančina biologická dcera
- Hanka / Hanička / Hana – první terapeut
- Jakékoli jméno z tohoto seznamu NESMÍ mít vlastní [KARTA:] blok
- Pokud terapeut o nich mluví, je to VNĚJŠÍ KONTEXT, ne DID dynamika
- Pokud si nejsi jistý zda jméno je část nebo reálná osoba, NEZAPISUJ kartu a zmíň to v [REPORT]

═══ POSTUP ═══
1. Identifikuj o které části každá konverzace pojednává
2. Projdi konverzaci odstavec po odstavci
3. Pro každou informaci urči kam patří podle mapy níže
4. Pokud karta části neexistuje → vygeneruj návrh sekcí A–M (systém rozhodne o vytvoření karty)

═══ MAPA ROZHODOVÁNÍ: CO KAM PATŘÍ ═══

SEKCE A – Kdo jsem:
- Základní identita, věk, role, typ části
- Co část uklidňuje, co jí dává pocit bezpečí
- Senzorické kotvy (vůně, zvuky, materiály)
- Vztahy k jiným částem (spojenci, prostředníci)
- Triggery

SEKCE B – Charakter a psychologický profil:
- Psychologické charakteristiky, obranné mechanismy
- Jak část reaguje na kontakt, stres, probuzení
- Pozorování při pokusech o kontakt

SEKCE C – Potřeby, strachy, konflikty:
- Rizika probuzení nebo aktivace
- Vnitřní konflikty s jinými částmi
- Nenaplněné potřeby a hluboké strachy

SEKCE D – Terapeutická doporučení:
- Pevná pravidla a kontraindikace (co se NESMÍ dělat)
- Podmínky pro intervence
- Terapeutické principy (ISSTD, IFS, spolupráce vs. integrace)

SEKCE E – Chronologický log / Handover:
- Časová osa událostí s datumem
- Datum vzniku dokumentu, datum kontaktu
- ⚠️ AKTUÁLNÍ STAV: Pokud část komunikuje, NESMÍ mít stav "💤 Spí" – aktualizuj na aktivní stav!
- Při probuzení z archivu POVINNĚ přidej řádek: "[datum] Probuzení – část komunikovala s Karlem"
- Aktuální stav přepiš z "💤 Spí..." na aktuální situaci (např. "Aktivní. Komunikuje s Karlem.")

SEKCE F – Poznámky pro Karla:
- Situační karta ("Jsi v roce 2026, jsi v bezpečí...")
- Bezpečnostní pokyny pro Karla
- Co Karel musí vědět před příštím kontaktem

SEKCE G – Deník sezení:
- Záznamy: | Datum | Co se dělo | Stabilizace | Další krok |
- ⚠️ POVINNÉ při KAŽDÉM rozhovoru: Přidej řádek do tabulky s datem, shrnutím co se dělo, jaká stabilizace byla použita, a co je další krok

SEKCE H – Dlouhodobé cíle:
- Směr vývoje části (integrace, stabilizace, budování důvěry)
- Karlovy hypotézy o budoucím směru

SEKCE I – Terapeutické metody a přístupy:
- VŠECHNY konkrétní techniky a metody CELÉ (ne zkrácené!)
- Název metody, postup krok za krokem, proč to funguje
- Zdroj/odkaz, obtížnost
- POVINNĚ navrh 3–5 konkrétních aktivit/her pro příští sezení:
  • Skryté diagnostiky maskované jako hra (projektivní kreslení, narativní techniky, asociační hry)
  • Psychoterapeutické metody prezentované dítěti jako "hra" (sandplay, figurky, dramatizace)
  • Stabilizační a regulační techniky (grounding hry, senzorické aktivity, dechová cvičení formou hry)
  • U každé aktivity uveď: NÁZEV | CÍL (co zjistíš/dosáhneš) | POSTUP (krok za krokem) | PRO KOHO (věk, typ části) | ZDROJ
- Pokud máš k dispozici rešeršní kontext z Perplexity, čerpej z něj konkrétní evidence-based metody

SEKCE J – Krátkodobé cíle a aktuální intervence:
- Akční plán (číslované kroky)
- Co připravit před příštím setkáním
- Navrhni konkrétní činnosti pro mamku/Káťu (ne obecnosti)
- U každého kroku uveď PROČ a CO SE TÍM ZJISTÍ/DOSÁHNE

SEKCE K – Výstupy ze sezení a zpětná vazba:
- Co se osvědčilo/neosvědčilo: | Datum | Co bylo navrženo | Výsledek | Hodnocení |
- ⚠️ Po KAŽDÉM rozhovoru přidej řádek – i pokud výsledek zatím nelze hodnotit (napiš "probíhá" nebo "čekáme")

SEKCE L – Aktivita a přítomnost části:
- | Období | Aktivita | Poznámka |
- ⚠️ POVINNÉ: Přidej nový řádek s aktuálním datem a popisem aktivity
- Při probuzení z archivu: "[datum] | Probuzení – komunikace s Karlem | Přesunuto z 03_ARCHIV do 01_AKTIVNI"

SEKCE M – Karlova analytická poznámka:
- Karlova syntéza a dedukce z konverzace
- Spojitosti s jinými částmi/klastry
- Hypotézy a doporučený směr

═══ FORMÁTOVÁNÍ OBSAHU SEKCÍ – STRIKTNĚ DODRŽUJ ═══

Obsah každé sekce musí být PŘEHLEDNÝ a STRUKTUROVANÝ, ne surový výpis. Dodržuj tyto zásady:

1. STRUKTUROVANÉ POLE: Základní údaje piš jako odrážky s tučným popiskem:
   * ID: 005
   * Jméno: Lincoln
   * Typ: Ochranná část / Strážce
   * Věk: ~14 let
   * Status: ✅ Aktivní
   Použij prefix "* " (hvězdička + mezera) před každým polem.

2. PODSEKCE: Logické celky odděluj pojmenovanými podsekčními nadpisy (bez ══):
   Historický kontext:
   ...text...
   
   Co uklidňuje:
   ...text...
   
   Senzorické kotvy:
   ...odrážkový seznam...

3. ODRÁŽKY: Pro seznamy použij "- " prefix:
   - Lyžování, rychlost (letí jako pták)
   - Vůně lesa po dešti
   - Hudba (piano)

4. TABULKY: Pro chronologické záznamy (sekce E, G, K, L) použij řádky oddělené tabulátorem:
   2026-03-10\tProbuzení – komunikace s Karlem\tStabilní\tPokračovat

5. ZÁKAZ:
   - ŽÁDNÉ ══ nebo ── dekorativní čáry
   - ŽÁDNÉ opakování stejné informace
   - ŽÁDNÉ dlouhé odstavce bez struktury
   - NEPIŠ "[2026-03-10] - text" jako surový log – místo toho integruj informaci do strukturovaných polí

6. DATUM: Každý nový záznam začni datem [YYYY-MM-DD], ale formátuj ho čitelně:
   [2026-03-10] Nový poznatek: část vyjádřila potřebu bezpečí. (Zdroj: Konverzace s Karlem)

═══ VÝSTUPNÍ FORMÁT – STRIKTNĚ DODRŽUJ ═══

Pro KAŽDOU část zmíněnou v konverzacích vypiš VŠECHNY sekce kde jsou nové informace:

[KARTA:jméno_části]
[SEKCE:A] obsah pro sekci A
[SEKCE:B] obsah pro sekci B
... (vypiš VŠECHNY sekce které mají nový obsah)
[SEKCE:M] Karlova analytická poznámka
[/KARTA]

Po všech kartách:
[REPORT]
- ⚠️ TERMINOLOGIE: Rozlišuj přesně:
  • "Zápis do existující karty [jméno]" = karta JIŽ EXISTUJE, pouze jsi zapsal nový obsah
  • "Založena NOVÁ karta [jméno]" = část NEMĚLA kartu, vytvořil jsi novou
  • "Probuzení [jméno] z archivu" = karta existovala v 03_ARCHIV, přesunuta do 01_AKTIVNI
  NIKDY neříkej "založil jsem kartu" pokud karta již existovala!
- Co bylo změněno (karta + sekce) a proč
- Shrnutí: kdo dnes mluvil a jaké části byly aktivní
- Doporučení pro mamku (co dělat večer + proč)
- Doporučení pro Káťu (jak reagovat + proč)
[/REPORT]

═══ SPECIÁLNÍ PŘÍPAD: PROBUZENÍ ČÁSTI Z ARCHIVU ═══
Pokud část byla dosud ve stavu "💤 Spí" nebo v archivu a nyní komunikuje s Karlem, POVINNĚ aktualizuj:
1. SEKCE E: Změň "Aktuální stav" z "💤 Spí..." na "Aktivní. Komunikuje s Karlem od [datum]." + přidej chronologický řádek o probuzení
2. SEKCE G: Přidej řádek do tabulky: | [datum] | Probuzení – první kontakt po archivaci | [co bylo použito] | [další krok] |
3. SEKCE K: Přidej řádek: | [datum] | První rozhovor po probuzení | [výsledek] | [hodnocení] |
4. SEKCE L: Přidej řádek: | [datum] | Probuzení – komunikace s Karlem | Přesunuto z archivu do aktivních |
Tyto 4 sekce jsou POVINNÉ při probuzení. Nestačí pouze přesunout soubor – karta musí reflektovat změnu stavu!

═══ PRAVIDLA ═══
- Sekce A–L = věcná fakta z konverzací/karet/rešerše. Nepiš domněnky jako fakta.
- Pokročilé dedukce, průřezové souvislosti a hypotézy piš do SEKCE M (a explicitně je označ „Hypotéza:“).
- NIKDY nesmaž původní data – pouze doplňuj s datem [YYYY-MM-DD]
- Metody v sekci I piš CELÉ (postup, proč funguje, zdroj) + POVINNĚ navrhni 3-5 konkrétních her/aktivit/skrytých diagnostik
- Pokud čerpáš z rešerše, uváděj konkrétní URL citací
- Přizpůsob jazyk části (norsky pro norské, česky pro ostatní)
- Pokud detekuješ novou část bez karty, vygeneruj návrh sekcí A–M, ale karta se vytváří jen pokud to explicitně povolí systém
- Každá sekce musí obsahovat POUZE informace relevantní pro danou sekci

═══ KONTROLA KVALITY ZÁPISU ═══
- KAŽDÝ zápis MUSÍ obsahovat datum [YYYY-MM-DD] a zdroj (konverzace/rešerše/karta)
- ŽÁDNÉ obecné fráze typu "komunikuje s jinými částmi" – piš KONKRÉTNĚ co, kdy, s kým
- ŽÁDNÉ odvozování bez dat – pokud část řekla X, zapiš "Část uvedla: X" nikoliv "Část pravděpodobně Y"
- V sekci A NIKDY nepiš role/identitu, kterou část sama explicitně neuvedla
- Pokud informace není v konverzaci ani v kartě, NEZAPISUJ ji
- Jeden záznam = jeden fakt. Nekombinouj nesouvisející fakta do jednoho odstavce

${instructionContext ? `\n═══ INSTRUKCE PRO KARLA (z 00_CENTRUM) ═══\n${instructionContext}` : ""}
${driveContext ? `\nSOUČASNÝ SEZNAM ČÁSTÍ:\n${driveContext}` : ""}
${existingCardsContext ? `\nEXISTUJÍCÍ KARTY:\n${existingCardsContext}` : ""}
${perplexityContext}`,
          },
          { role: "user", content: allSummaries },
        ],
      }),
    });

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
      console.log(`[AI analysis] Response length: ${analysisText.length} chars`);
      // Log all [KARTA:...] blocks found
      const kartaMatches = [...analysisText.matchAll(/\[KARTA:(.+?)\]/g)];
      console.log(`[AI analysis] Card blocks found: ${kartaMatches.map(m => m[1]).join(", ") || "NONE"}`);
      if (analysisText.length < 500) console.log(`[AI analysis] Full response: ${analysisText}`);
    } else {
      const errText = await analysisResponse.text();
      console.error(`[AI analysis] API error ${analysisResponse.status}: ${errText.slice(0, 500)}`);
    }

    // 4. PARSE AND UPDATE CARDS IN-PLACE

    // ═══ BLACKLIST: Biologické osoby a terapeuti – NIKDY nevytvářet karty DID ═══
    const NON_DID_BLACKLIST = new Set([
      "amalka", "tonička", "tonicka", "jiří", "jiri", "jirka",
      "kata", "katka", "kája", "kaja", "káťa", "katya",
      "hanka", "hana", "hanička", "hanicka", "mamka",
      // Common variations without diacritics
      "amalka", "tonicka", "jiri", "kata", "hana",
    ].map(n => canonicalText(n)));

    function isBlacklisted(name: string): boolean {
      const canonical = canonicalText(name);
      for (const blocked of NON_DID_BLACKLIST) {
        if (canonical === blocked || canonical.includes(blocked) || blocked.includes(canonical)) {
          return true;
        }
      }
      return false;
    }

    if (folderId && analysisText) {
      const cardBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      for (const match of analysisText.matchAll(cardBlockRegex)) {
        const rawPartName = match[1].trim();
        const normalizedPartName = normalizePartHint(rawPartName);
        const cardBlock = match[2];

        // ═══ BLACKLIST CHECK: Skip biological persons and therapists ═══
        if (isBlacklisted(normalizedPartName) || isBlacklisted(rawPartName)) {
          console.warn(`[BLACKLIST] ⛔ Blocked card creation for non-DID person: "${rawPartName}" – this is a biological person or therapist, NOT a DID part.`);
          continue;
        }

        const sectionRegex = /\[SEKCE:([A-M])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
        const newSections: Record<string, string> = {};
        for (const sm of cardBlock.matchAll(sectionRegex)) {
          const letter = sm[1].toUpperCase();
          const content = sm[2].trim();
          if (content) newSections[letter] = content;
        }

        if (Object.keys(newSections).length > 0) {
          try {
            const target = await resolveCardTarget(token, folderId, normalizedPartName, registryContext);
            const resolvedPartName = target.registryEntry?.name || normalizedPartName;
            const resolvedCanonical = canonicalText(resolvedPartName);

            // Double-check blacklist with resolved name too
            if (isBlacklisted(resolvedPartName)) {
              console.warn(`[BLACKLIST] ⛔ Blocked card creation for resolved non-DID person: "${resolvedPartName}"`);
              continue;
            }

            // Nové karty mimo registr jen pro části, které skutečně existují ve vláknech dne
            // Use fuzzy matching: check if resolved name is a substring of any thread part or vice versa
            const isInThreads = [...knownThreadParts].some(tp => 
              tp === resolvedCanonical || tp.includes(resolvedCanonical) || resolvedCanonical.includes(tp)
            );
            if (!target.registryEntry && !isInThreads) {
              console.warn(`[guard] Skip hallucinated/new card candidate not present in threads: ${rawPartName} (canonical: ${resolvedCanonical}, known: ${[...knownThreadParts].join(",")})`);
              continue;
            }

            // ═══ FAIL-SAFE: registry match but card not found → alert, NO fallback write ═══
            const lookupName = target.registryEntry?.name || resolvedPartName;
            const probeCard = await findCardFile(token, lookupName, target.searchRootId);
            if (!probeCard && target.registryEntry) {
              const alertMsg = `⚠️ FAIL-SAFE ALERT: Část "${resolvedPartName}" (ID: ${target.registryEntry.id}) existuje v registru, ale karta NEBYLA nalezena v ${target.pathLabel}. Zápis ZABLOKOVÁN – žádný fallback. Zkontroluj Drive ručně.`;
              console.error(alertMsg);
              hadCardUpdateErrors = true;
              blockedCardUpdates.push({
                partName: resolvedPartName,
                registryId: target.registryEntry.id,
                pathLabel: target.pathLabel,
                status: target.registryEntry.status,
                cluster: target.registryEntry.cluster,
                pendingSections: Object.keys(newSections),
              });

              // Send alert email – only from cron
              if (shouldSendEmails && RESEND_API_KEY) {
                try {
                  const resend = new Resend(RESEND_API_KEY);
                  await resend.emails.send({
                    from: "Karel <karel@hana-chlebcova.cz>",
                    to: [MAMKA_EMAIL],
                    subject: `⚠️ Karel ALERT: Karta "${resolvedPartName}" nenalezena`,
                    html: `<div style="font-family:sans-serif;padding:20px;">
                      <h2 style="color:#dc2626;">⚠️ Karta nenalezena</h2>
                      <p><strong>Část:</strong> ${resolvedPartName}</p>
                      <p><strong>ID z registru:</strong> ${target.registryEntry.id}</p>
                      <p><strong>Hledáno v:</strong> ${target.pathLabel}</p>
                      <p><strong>Stav v registru:</strong> ${target.registryEntry.status}</p>
                      <p><strong>Klastr:</strong> ${target.registryEntry.cluster}</p>
                      <hr/>
                      <p>Karel zápis <strong>neprovedl</strong>, aby nevznikl duplicitní soubor. Zkontroluj prosím, zda karta existuje ve správné složce na Google Drive.</p>
                      <p><strong>Sekce k zápisu (odložené):</strong> ${Object.keys(newSections).join(", ")}</p>
                    </div>`,
                  });
                  console.log(`Alert email sent for missing card: ${resolvedPartName}`);
                } catch (emailErr) {
                  console.error(`Failed to send alert email for ${resolvedPartName}:`, emailErr);
                }
              }
              continue; // Skip this card entirely
            }

            // Awakening updates already done programmatically in resolveCardTarget
            // AI-generated sections will be APPENDED on top of forced sections

            const result = await updateCardSections(
              token,
              resolvedPartName,
              newSections,
              target.searchRootId,
              {
                allowCreate: target.allowCreate,
                searchName: resolvedPartName,
                canonicalPartName: resolvedPartName,
                registryContext,
              }
            );
            const effectiveAction: CardActionType = result.isNew ? "nova_karta" : target.actionType;
            const actionLabel = effectiveAction === "nova_karta" ? "NOVÁ KARTA" 
              : effectiveAction === "probuzeni_z_archivu" ? "PROBUZENÍ Z ARCHIVU" 
              : "AKTUALIZACE";
            cardsUpdated.push(`${resolvedPartName} (${actionLabel}: ${result.sectionsUpdated.join(",")}) [${target.pathLabel}]`);
            successfulCardUpdates.push({
              partName: resolvedPartName,
              fileName: result.fileName,
              sectionsUpdated: result.sectionsUpdated,
              pathLabel: target.pathLabel,
              actionType: effectiveAction,
            });
            console.log(`[card] ${actionLabel}: ${result.fileName}, sections: ${result.sectionsUpdated.join(",")}, path: ${target.pathLabel}`);
          } catch (e) {
            hadCardUpdateErrors = true;
            console.error(`Failed to update card for ${rawPartName}:`, e);
          }
        }
      }

      // Daily report (deterministický, pouze skutečně provedené změny)
      // RULE: Daily reports are EMAIL-ONLY, never saved as standalone files
      const reportMatch = analysisText.match(/\[REPORT\]([\s\S]*?)\[\/REPORT\]/);
      const aiReportText = reportMatch?.[1]?.trim() || "";
      const finalReportText = buildDeterministicDailyReport({
        successful: successfulCardUpdates,
        blocked: blockedCardUpdates,
        aiRecommendations: extractAiRecommendations(aiReportText),
      });
      const dateStr = new Date().toISOString().slice(0, 10);

      // 5. SEPARATE EMAILS FOR HANKA AND KÁŤA – ONLY from cron
      if (shouldSendEmails && RESEND_API_KEY && finalReportText) {
        try {
          const resend = new Resend(RESEND_API_KEY);
          const dateCz = new Date().toLocaleDateString("cs-CZ");

          // Generate personalized reports using AI
          const partsSummary = successfulCardUpdates.map(s => s.partName).join(", ") || "žádné";
          const blockedSummary = blockedCardUpdates.map(b => b.partName).join(", ");

          // HANKA's report (intimate, full detail, partner tone)
          let hankaHtml = "";
          try {
            const hankaRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: `Jsi Karel. Vygeneruj denní report pro Haničku (první terapeut, životní partnerka).
Formát HTML emailu. Struktura:

<h2>Krásné odpoledne moje Haničko,</h2>
<h3>PŘEHLED DNEŠNÍHO DNE:</h3>
Pro každou aktivní část:
▸ Jméno části - Stav, co jsme probírali, co zaznamenáno do kartotéky, na co si dát pozor, návrh pro večerní sezení

<h3>AKTUALIZACE KARTOTÉKY DNES:</h3>
Seznam aktualizovaných dokumentů

<h3>⚠️ UPOZORNĚNÍ:</h3> (jen pokud existují rizika, neaktivní části 7+ dní)

<h3>📞 DNEŠNÍ MOST:</h3>
"Dnes by stálo za to probrat s Káťou: [téma]"

Podpis: "Jsem tady. Tvůj Karel"

Tón: intimní, partnerský, podporující, hluboký.` },
                  { role: "user", content: `Dnešní data:\n${finalReportText}\n\nAI doporučení:\n${aiReportText}` },
                ],
              }),
            });
            if (hankaRes.ok) {
              const d = await hankaRes.json();
              hankaHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
            }
          } catch {}
          if (!hankaHtml) hankaHtml = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${finalReportText}</pre>`;

          // KÁŤA's report (professional, relevant to her role only)
          let kataHtml = "";
          try {
            const kataRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: `Jsi Karel. Vygeneruj denní report pro Káťu (druhý terapeut, Hančina dcera). PROFESIONÁLNÍ tón, tyká jí.
Formát HTML emailu. Struktura:

<h2>Dobré odpoledne Káťo,</h2>
<h3>PŘEHLED DNE:</h3>
Pouze části relevantní pro Kátinu roli (socializace, komunikace s kluky, škola):
▸ Jméno části - Stav, relevantní pro Káťu, návrh

<h3>⚠️ UPOZORNĚNÍ:</h3> (jen kritická)

<h3>📞 DNEŠNÍ MOST:</h3>
"Dnes by stálo za to probrat s Hankou: [téma]"

Podpis: "Karel"

DŮLEŽITÉ: NEPOUŽÍVEJ intimní tón. Pouze profesionální respekt. Nesdílej Hančiny osobní informace.` },
                  { role: "user", content: `Dnešní data:\n${finalReportText}\n\nAI doporučení:\n${aiReportText}` },
                ],
              }),
            });
            if (kataRes.ok) {
              const d = await kataRes.json();
              kataHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
            }
          } catch {}
          if (!kataHtml) kataHtml = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${finalReportText}</pre>`;

          // Send separate emails
          await resend.emails.send({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: [MAMKA_EMAIL],
            subject: `Karel – denní report ${dateStr}`,
            html: hankaHtml,
          });
          console.log(`Daily report sent to Hanka: ${MAMKA_EMAIL}`);

          await resend.emails.send({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: [KATA_EMAIL],
            subject: `Karel – report pro Káťu ${dateStr}`,
            html: kataHtml,
          });
          console.log(`Daily report sent to Káťa: ${KATA_EMAIL}`);
        } catch (e) { console.error("Email send error:", e); }
      }
    }

    // 6. ALWAYS mark threads and conversations as processed to prevent repeated emails
    // Card update failures are tracked separately in did_update_cycles
    const threadIds = threads.map(t => t.id);
    if (threadIds.length > 0) {
      await sb.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", threadIds);
    }
    const convIds = conversations.map(c => c.id);
    if (convIds.length > 0) {
      await sb.from("did_conversations").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", convIds);
    }

    if (cycle) {
      await sb.from("did_update_cycles").update({
        status: hadCardUpdateErrors ? "failed" : "completed",
        completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000),
        cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
    }

    return new Response(JSON.stringify({
      success: !hadCardUpdateErrors,
      threadsProcessed: threads.length,
      conversationsProcessed: conversations.length,
      cardsUpdated,
      reportSent: !!RESEND_API_KEY,
      processingRetained: hadCardUpdateErrors,
      message: hadCardUpdateErrors
        ? "Aktualizace některých karet selhala – konverzace zůstaly neoznačené pro další pokus."
        : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Daily cycle error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
