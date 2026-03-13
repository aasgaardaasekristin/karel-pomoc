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

async function appendToDoc(token: string, fileId: string, textToAppend: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) return;
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: endIndex - 1 }, text: textToAppend } }] }),
  });
  if (!updateRes.ok) console.warn(`[appendToDoc] Failed: ${updateRes.status}`);
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
  const kartotekaId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
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
  const authHeaderTrimmed = authHeader.trim();
  const userAgent = (req.headers.get("User-Agent") || "").toLowerCase();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";

  const tokenMatchesKnownKey = [serviceRoleKey, anonKey, publishableKey]
    .filter(Boolean)
    .some((key) => authHeaderTrimmed === `Bearer ${key}`);

  // pg_cron + pg_net calls can arrive with auth header variants; accept only when explicitly marked as cron source
  let requestBody: any = {};
  try { requestBody = await req.clone().json(); } catch {}
  const isCronSource = requestBody?.source === "cron";
  const isPgNetCaller = userAgent.includes("pg_net");
  const isCronCall = tokenMatchesKnownKey || (isCronSource && isPgNetCaller);

  let resolvedUserId: string | null = null;
  if (!isCronCall) {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
    resolvedUserId = (authResult as { user: any }).user?.id || null;
  }
  // For cron calls, look up any user from did_threads to use as owner
  if (!resolvedUserId) {
    const tmpSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: anyThread } = await tmpSb.from("did_threads").select("user_id").limit(1).single();
    resolvedUserId = anyThread?.user_id || null;
  }

  // ═══ EMAIL GUARD: Only send report emails from scheduled cron calls ═══
  const isTestEmail = requestBody?.testEmail === true;
  const shouldSendEmails = (isCronCall && isCronSource) || isTestEmail;
  if (!shouldSendEmails) {
    console.log("[daily-cycle] Manual invocation – will process cards but NOT send report emails.");
  }

  let cycleId: string | null = null;
  let sb: ReturnType<typeof createClient> | null = null;

  try {
    // ═══ FAST-PATH: syncRegistry – batched: list + process_one ═══
    if (requestBody?.syncRegistry) {
      const mode = requestBody.syncMode || "list";
      const token = await getAccessToken();
      const folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
      if (!folderId) throw new Error("kartoteka_DID folder not found");
      const rc = await loadRegistryContext(token, folderId);
      if (!rc.activeFolderId) throw new Error("01_AKTIVNI_FRAGMENTY not found");

      if (mode === "list") {
        // Phase 1: Collect all card files, return list for client to iterate
        const allCardFiles: Array<{ fileId: string; fileName: string; folderLabel: string }> = [];
        for (const [fid, label] of [[rc.activeFolderId, "01_AKTIVNI"], [rc.archiveFolderId, "03_ARCHIV"]] as [string | null, string][]) {
          if (!fid) continue;
          const files = await listFilesRecursive(token, fid);
          for (const f of files) {
            if (isTextCandidateFile(f)) allCardFiles.push({ fileId: f.id, fileName: f.name, folderLabel: label });
          }
        }
        return new Response(JSON.stringify({
          success: true,
          entries: allCardFiles,
          registryCount: rc.entries.length,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (mode === "process_one") {
        // Phase 2: Process a single card by fileId
        const { fileId, fileName, folderLabel } = requestBody as { fileId: string; fileName: string; folderLabel: string };
        if (!fileId) throw new Error("Missing fileId");

        let content: string;
        try { content = await readFileContent(token, fileId); } catch {
          return new Response(JSON.stringify({ result: "skip", reason: "unreadable" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (!looksLikeDidCard(fileName || "", content)) {
          return new Response(JSON.stringify({ result: "skip", reason: "not_a_card" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const partName = partNameFromFileName(fileName || "");
        const entry = findBestRegistryEntry(partName, rc.entries);
        let resultMsg = "";

        if (entry) {
          // Already registered – rename if needed
          const expectedPrefix = `${entry.id}_`;
          if (!fileName.startsWith(expectedPrefix)) {
            const normalizedName = entry.name.replace(/\s+/g, "_").toUpperCase();
            const expectedFileName = `${entry.id}_${normalizedName}`;
            await renameDriveFile(token, fileId, expectedFileName);
            resultMsg += `✏️ Přejmenováno → ${expectedFileName}. `;
          }

          // Update existing row with metadata
          const meta = extractCardMetadata(content);
          const isArchived = (folderLabel || "").includes("ARCHIV");
          const currentStatus = isArchived ? "Spí" : "Aktivní";
          const rowIndex = rc.entries.indexOf(entry);
          if (rowIndex >= 0 && rc.registryFileId && rc.registrySheetName) {
            const sheetRow = rowIndex + 2;
            const escapedSheet = `'${rc.registrySheetName.replace(/'/g, "''")}'`;
            const range = `${escapedSheet}!C${sheetRow}:F${sheetRow}`;
            const updateRes = await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${rc.registryFileId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
              {
                method: "PUT",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ values: [[meta.age, currentStatus, meta.cluster, meta.role]] }),
              }
            );
            if (updateRes.ok) {
              resultMsg += `📊 Řádek ${sheetRow}: Věk=${meta.age || "?"}, Status=${currentStatus}, Klastr=${meta.cluster || "?"}, Role=${(meta.role || "?").slice(0, 40)}`;
            } else {
              await updateRes.text();
              resultMsg += `⚠️ Nepodařilo se aktualizovat řádek`;
            }
          }
          return new Response(JSON.stringify({ result: "updated", name: entry.name, detail: resultMsg }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          // Orphan – register and rename
          const nextId = getNextRegistryId(rc.entries);
          const paddedId = String(nextId).padStart(3, "0");
          const normalizedName = partName.replace(/\s+/g, "_").toUpperCase();
          const expectedFileName = `${paddedId}_${normalizedName}`;
          const meta = extractCardMetadata(content);

          if (rc.registryFileId && rc.registrySheetName) {
            await addRegistryRow(token, rc.registryFileId, rc.registrySheetName, paddedId, partName, "Aktivní", meta.age, meta.cluster, meta.role);
          }
          await renameDriveFile(token, fileId, expectedFileName);
          return new Response(JSON.stringify({ result: "new", name: partName, newId: paddedId, newFileName: expectedFileName }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      return new Response(JSON.stringify({ error: "Unknown syncMode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ FAST-PATH: reformat only (no DB, no AI, no email) ═══
    if (requestBody?.reformat) {
      const token = await getAccessToken();
      const folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
      if (!folderId) throw new Error("kartoteka_DID folder not found");
      
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
    sb = createClient(supabaseUrl, supabaseKey);

    const reportDatePrague = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
    const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
    let emailSentToHanka = false;
    let emailSentToKata = false;

    const reserveDispatchSlot = async (recipient: "hanka" | "kata"): Promise<boolean> => {
      const nowIso = new Date().toISOString();
      const dispatchTable = (sb as any).from("did_daily_report_dispatches");

      const { data: existing, error: existingErr } = await dispatchTable
        .select("id, status, updated_at")
        .eq("report_date", reportDatePrague)
        .eq("recipient", recipient)
        .maybeSingle();

      if (existingErr) {
        console.error(`[email-dedupe] lookup failed (${recipient}):`, existingErr.message);
        return false;
      }

      if (existing?.status === "sent") {
        console.log(`[email-dedupe] ${recipient} already sent for ${reportDatePrague}, skipping.`);
        return false;
      }

      if (existing) {
        const updatedAt = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const isStalePending = existing.status === "pending" && (Date.now() - updatedAt > 90 * 60 * 1000);

        if (existing.status === "pending" && !isStalePending) {
          console.log(`[email-dedupe] ${recipient} dispatch currently pending, skipping duplicate send.`);
          return false;
        }

        const { error: bumpErr } = await dispatchTable
          .update({
            status: "pending",
            cycle_id: cycleId,
            updated_at: nowIso,
            error_message: null,
          })
          .eq("id", existing.id);

        if (bumpErr) {
          console.error(`[email-dedupe] failed to reserve existing row (${recipient}):`, bumpErr.message);
          return false;
        }
        return true;
      }

      const { error: insertErr } = await dispatchTable.insert({
        report_date: reportDatePrague,
        recipient,
        status: "pending",
        cycle_id: cycleId,
      });

      if (insertErr) {
        if ((insertErr as any).code === "23505") {
          console.log(`[email-dedupe] concurrent reservation detected for ${recipient}, skipping.`);
          return false;
        }
        console.error(`[email-dedupe] failed to reserve slot (${recipient}):`, insertErr.message);
        return false;
      }

      return true;
    };

    const markDispatchSent = async (recipient: "hanka" | "kata") => {
      await (sb as any)
        .from("did_daily_report_dispatches")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null })
        .eq("report_date", reportDatePrague)
        .eq("recipient", recipient);
    };

    const markDispatchFailed = async (recipient: "hanka" | "kata", errorMessage: string) => {
      await (sb as any)
        .from("did_daily_report_dispatches")
        .update({ status: "failed", updated_at: new Date().toISOString(), error_message: errorMessage.slice(0, 1000) })
        .eq("report_date", reportDatePrague)
        .eq("recipient", recipient);
    };

    const sendEmailOnce = async (recipient: "hanka" | "kata", to: string, subject: string, html: string): Promise<boolean> => {
      if (!shouldSendEmails || !resend) return false;
      const reserved = await reserveDispatchSlot(recipient);
      if (!reserved) return false;

      try {
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [to],
          subject,
          html,
        });
        await markDispatchSent(recipient);
        return true;
      } catch (e) {
        await markDispatchFailed(recipient, e instanceof Error ? e.message : String(e));
        throw e;
      }
    };

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

    // Load DID-relevant research threads for therapeutic plan context
    const { data: researchThreadRows } = await sb.from("research_threads").select("*").eq("is_deleted", false);
    const researchThreads = (researchThreadRows ?? []).filter((rt: any) => {
      // Filter to DID-relevant threads by checking topic and message content
      const topic = (rt.topic || "").toLowerCase();
      const didKeywords = ["did", "disociat", "fragment", "část", "part", "alter", "system", "kluk", "kluci", "dítě", "deti", "trauma", "dissoci", "kartoteka", "kartotéka"];
      return didKeywords.some(kw => topic.includes(kw)) || 
        ((rt.messages as any[]) || []).some((m: any) => 
          typeof m.content === "string" && didKeywords.some(kw => m.content.toLowerCase().includes(kw))
        );
    });
    console.log(`[daily-cycle] Research threads loaded: ${researchThreadRows?.length || 0} total, ${researchThreads.length} DID-relevant`);

    // Load pending therapist tasks for accountability analysis
    const { data: pendingTasks } = await sb.from("did_therapist_tasks")
      .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, note")
      .neq("status", "done")
      .order("created_at", { ascending: true });
    const pendingTasksSummary = (pendingTasks || []).map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
      return `- [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}${age >= 3 ? " ⚠️ ESKALACE" : ""}`;
    }).join("\n");
    console.log(`[daily-cycle] Pending therapist tasks: ${pendingTasks?.length || 0}`);

    const cycleInsertPayload: any = { cycle_type: "daily", status: "running" };
    if (resolvedUserId) cycleInsertPayload.user_id = resolvedUserId;
    const { data: cycle, error: cycleErr } = await sb.from("did_update_cycles").insert(cycleInsertPayload).select().single();
    if (cycleErr) console.error("[daily-cycle] Failed to create cycle record:", cycleErr.message);
    cycleId = cycle?.id || null;

    // 2. NORMALIZACE STRUKTURY KARET A-M (probíhá vždy)
    const token = await getAccessToken();
    const folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");

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
          const dateStr = reportDatePrague;

          if (resend && LOVABLE_API_KEY) {

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

            emailSentToHanka = await sendEmailOnce(
              "hanka",
              MAMKA_EMAIL,
              `Karel – denní report ${dateStr}`,
              hankaHtml,
            );

            emailSentToKata = await sendEmailOnce(
              "kata",
              KATA_EMAIL,
              `Karel – report pro Káťu ${dateStr}`,
              kataHtml,
            );
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
          reportSent: emailSentToHanka || emailSentToKata,
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

    // Compile DID-relevant research thread summaries
    const researchSummaries = researchThreads.map((rt: any) => {
      const msgs = ((rt.messages as any[]) || []).slice(-15);
      return `=== Profesní zdroj: ${rt.topic} (autor: ${rt.created_by}) ===\nVytvořeno: ${rt.created_at}\nPoslední aktivita: ${rt.last_activity_at}\n\nKlíčové body:\n${msgs.map((m: any) => `[${m.role === "user" ? "TERAPEUT" : "KAREL"}]: ${typeof m.content === "string" ? clip(m.content, 400) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    const allSummaries = [threadSummaries, convSummaries, researchSummaries ? `\n\n=== RELEVANTNÍ PROFESNÍ ZDROJE (Research vlákna týkající se DID) ===\n\n${researchSummaries}` : ""].filter(Boolean).join("\n\n=== KONVERZACE Z JINÝCH PODREŽIMŮ ===\n\n");
    const knownThreadParts = new Set(
      reportThreads
        .map((t) => canonicalText(normalizePartHint(t.part_name || "")))
        .filter(Boolean)
    );
    let driveContext = "";
    let existingCards: Record<string, string> = {};
    let instructionContext = "";
    let centrumDocsContext = "";
    let centrumFolderId: string | null = null;

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

      // Load 00_CENTRUM documents for dedup context
      // centrumDocsContext and centrumFolderId declared above
      try {
        const rootChildren = await listFilesInFolder(token, folderId);
        const centerFolder = rootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^00/.test(f.name.trim()) || canonicalText(f.name).includes("centrum")));
        if (centerFolder) {
          centrumFolderId = centerFolder.id;
          const centrumDocNames = ["05_Operativni_Plan", "05_Terapeuticky_Plan_Aktualni", "00_Aktualni_Dashboard", "04_Mapa_Vztahu", "06_Strategicky_Vyhled"];
          const centerFiles = await listFilesInFolder(token, centerFolder.id);
          for (const docName of centrumDocNames) {
            const canonical = canonicalText(docName);
            const file = centerFiles.find(f => canonicalText(f.name).includes(canonical) || f.name.includes(docName));
            if (file) {
              try {
                const content = await readFileContent(token, file.id);
                const trimmed = content.length > 3000 ? content.slice(0, 3000) + "…" : content;
                centrumDocsContext += `\n=== EXISTUJÍCÍ CENTRUM DOC: ${file.name} ===\n${trimmed}\n`;
              } catch {}
            }
          }
          // Load 06_Strategicky_Vyhled as a single document (no longer a folder of agreements)
          const strategicFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && (canonicalText(f.name).includes("strategick") || canonicalText(f.name).includes("06strategick")));
          if (strategicFile) {
            try {
              const content = await readFileContent(token, strategicFile.id);
              const trimmed = content.length > 3000 ? content.slice(0, 3000) + "…" : content;
              centrumDocsContext += `\n=== EXISTUJÍCÍ CENTRUM DOC: ${strategicFile.name} ===\n${trimmed}\n`;
              console.log(`[daily-cycle] Loaded 06_Strategicky_Vyhled (${content.length} chars)`);
            } catch {}
          }
          // Fallback: also check old 06_Terapeuticke_Dohody folder for backward compatibility
          if (!strategicFile) {
            const dohodyCandidates = centerFiles.filter(f => canonicalText(f.name).includes("terapeutick") && canonicalText(f.name).includes("dohod"));
            if (dohodyCandidates.length > 0) {
              for (const d of dohodyCandidates.slice(0, 1)) {
                if (d.mimeType === DRIVE_FOLDER_MIME) {
                  const subFiles = await listFilesInFolder(token, d.id);
                  let totalDohodaChars = 0;
                  const MAX_DOHODA_CHARS = 12000;
                  for (const sf of subFiles.sort((a, b) => b.name.localeCompare(a.name))) {
                    if (totalDohodaChars >= MAX_DOHODA_CHARS) break;
                    try {
                      const content = await readFileContent(token, sf.id);
                      const trimmed = content.length > 2000 ? content.slice(0, 2000) + "…" : content;
                      centrumDocsContext += `\n=== LEGACY DOHODA: ${sf.name} ===\n${trimmed}\n`;
                      totalDohodaChars += trimmed.length;
                    } catch {}
                  }
                } else {
                  try {
                    const content = await readFileContent(token, d.id);
                    centrumDocsContext += `\n=== EXISTUJÍCÍ CENTRUM DOC: ${d.name} ===\n${content.length > 2000 ? content.slice(0, 2000) + "…" : content}\n`;
                  } catch {}
                }
              }
            }
          }
          if (centrumDocsContext) console.log(`[daily-cycle] Loaded CENTRUM docs context (${centrumDocsContext.length} chars)`);
        }
      } catch (e) { console.warn("Failed to load CENTRUM docs for dedup:", e); }
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
⚠️ ABSOLUTNÍ PRIORITA: Následující osoby NEJSOU části DID systému, jsou to reální lidé. NIKDY pro ně NEVYTVÁŘEJ [KARTA:...] blok:
- Amálka (7 let) – biologická dcera Káti a Jiřího
- Tonička (4 roky) – biologická dcera Káti a Jiřího  
- Jiří – Kátin manžel
- Káťa / Katka / Kája – druhý terapeut, Hančina biologická dcera
- Hanka / Hanička / Hana – první terapeut

⚠️ ALIASY – VŠECHNY ZNAMENAJÍ AMÁLKU + TONIČKU (biologické děti, NE DID části):
"holky" = "holčičky" = "děti Káti" = "děti" = "Káťiny děti" = "Káťiny holky" = "malé" = "ty dvě" = "kluci a holky" (pokud kontext = rodina)
Kdykoli se v rozhovoru objeví JAKÝKOLI z těchto výrazů v kontextu rodiny → jde o Amálku (7) a Toničku (4).
TYTO DĚTI NEJSOU DID ČÁSTI.

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

SEKCE H – Dlouhodobé cíle + Talent & Growth Profile:
- Směr vývoje části (integrace, stabilizace, budování důvěry)
- Karlovy hypotézy o budoucím směru
- ⚠️ TALENT PROFIL: Pokud z rozhovoru vyplyne nová schopnost, zájem nebo talent části, POVINNĚ zapiš ve formátu:
  TALENT: [oblast (např. fyzika, klavír, kreslení, jazyky)] | ÚROVEŇ: [začátečník/pokročilý/expert] | AKTIVITA: [co dělat pro rozvoj] | ZDROJ: [odkud info]
- Dlouhodobé cíle formuluj nejen terapeuticky, ale i EDUKAČNĚ – jak využít talent části pro její rozvoj, uplatnění v životě a budování identity
- Pro každý identifikovaný talent navrhni minimálně 1 konkrétní rozvojovou aktivitu přiměřenou věku a schopnostem části
- Příklady talentů: fyzika, matematika, hudba (klavír, zpěv), sport (lyže, plavání), kreslení, jazyky, programování, řemesla, psaní, tanec, vaření
- Cíl: každá část se stává "geniálním funkčním fragmentem" s uplatněním svých unikátních schopností

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

═══ AKTUALIZACE DOKUMENTŮ 00_CENTRUM ═══
Pokud z rozhovorů (zejména terapeutických – mamka/kata režim) vyplývají relevantní informace pro CENTRUM dokumenty, vypiš je v tomto formátu:

[CENTRUM:05_Operativni_Plan]
⚠️ TENTO DOKUMENT JE KLÍČOVÝ – Karel jej spravuje jako vedoucí terapeutického týmu.
Vygeneruj KOMPLETNÍ aktualizovaný dokument (ne jen doplněk). Struktura:

SEKCE 1 – AKTIVNÍ ČÁSTI A AKTUÁLNÍ STAV
Tabulka: | Část / ID | Aktuální stav | Kdo pracuje | Priorita tento týden | Poznámka |
Pro KAŽDOU aktivní část vyplň konkrétní data z dnešních rozhovorů, karet a rešerší.

SEKCE 2 – PLÁN SEZENÍ NA TENTO TÝDEN
Pro každou aktivní část:
- S kým (Hanka/Káťa)
- Metoda/technika (z rešerší + karet)
- Cíl sezení
- Jak oslovit (tón, jazyk)
- Na co si dát pozor

SEKCE 3 – AKTIVNÍ ÚKOLY + HODNOCENÍ PLNĚNÍ
☐/☑ Hanka: [úkol, termín, zdroj, stav plnění]
☐/☑ Káťa: [úkol, termín, zdroj, stav plnění]
Nesplněné z minulého týdne se přenesou automaticky.
Karel zde zaznamenává kdo co splnil a kdo ne – accountability tracking.

SEKCE 4 – KOORDINACE TERAPEUTŮ + DNEŠNÍ MOST
- Dnešní most (téma pro telefonát): "Dnes by stálo za to probrat: [téma]"
- Co Hanka udělala / co Káťa udělala
- Kde je třeba synchronizace
- Přímé otázky: "Hani, jak dopadlo X?" / "Káťo, pokročilas s Y?"

SEKCE 5 – UPOZORNĚNÍ A RIZIKA
- Triggery (výročí, události, změny)
- Části v ohrožení
- Kontraindikace
- Nesplněné úkoly 3+ dní → ESKALACE

SEKCE 6 – KARLOVY POZNÁMKY
- Postřehy z rozhovorů
- Hypotézy k ověření
- Co fungovalo / nefungovalo
- Hodnocení spolupráce terapeutického týmu

DŮLEŽITÉ PRO TENTO DOKUMENT:
- Piš CELÝ dokument, ne jen doplněk – dokument se přepisuje celý
- Čerpej z VŠECH zdrojů: dnešní rozhovory s částmi, rozhovory s terapeuty (mamka/kata režim), profesní zdroje (Research vlákna POUZE ta co se týkají DID), existující karty částí, strategický výhled
- Karel vystupuje jako AKTIVNÍ vedoucí týmu – koordinuje, superviduje, hodnotí, motivuje
- Dokument musí být OKAMŽITĚ AKČNÍ – terapeut otevře a hned ví co dělat
- Formátuj esteticky, přehledně, s tabulkami a odrážkami
[/CENTRUM]

[CENTRUM:06_Strategicky_Vyhled]
Nové strategické poznatky – POUZE pokud z dnešních rozhovorů vyplývají změny pro střednědobé/dlouhodobé cíle, strategii práce s částmi, nebo odložená témata. Denní cyklus pouze DOPLŇUJE (append) do strategického výhledu.
[/CENTRUM]

[CENTRUM:00_Aktualni_Dashboard]
⚠️ TENTO DOKUMENT SE PŘEPISUJE CELÝ – vygeneruj kompletní nový obsah, ne doplněk.
Dashboard je "kontrolní panel" – čitelný za 30 sekund, nikdy archiv.

POVINNÁ STRUKTURA (7 sekcí):

SEKCE 1 – STAV SYSTÉMU TEĎ
Pro KAŽDOU aktivní část:
▸ Jméno [stav emoji] – kdo frontuje, nálada, stabilita (🟢🟡🔴), poslední kontakt
▸ Aktuální riziko (nízké/střední/vysoké)
Souhrn: kolik částí aktivních, kolik spí, celková stabilita systému 1-10

SEKCE 2 – KRITICKÁ UPOZORNĚNÍ ⚠️
- Triggery dne (roční období, blížící se události, výročí traumat)
- Nesplněné dohody nebo úkoly po termínu
- Části v ohrožení (destabilizace, regrese, konflikty)
- Blížící se termíny (škola, terapie, lékař)
Pokud žádná upozornění: "✅ Žádná kritická upozornění"

SEKCE 3 – CO SE DĚLO POSLEDNÍCH 24H
- Kdo mluvil s Karlem (jména, délka, téma)
- Klíčové momenty a důležité výroky
- Změny stavů (probuzení, usnutí, switche)
- Co nového se Karel dozvěděl

SEKCE 4 – WATCHLIST SPÍCÍCH ČÁSTÍ 💤
Pro KAŽDOU spící část:
▸ Jméno – jak dlouho spí, důvod
▸ Riziko spontánního probuzení (nízké/střední/vysoké)
▸ Doporučení: nechat/probudit a proč

SEKCE 5 – TERAPEUTICKÝ FOKUS DNE 🎯
Top 1-3 priority (zjednodušené z 05_Terapeuticky_Plan):
▸ S kým pracovat
▸ Jakou metodou
▸ Co tím dosáhnout
Akční, okamžitě srozumitelné – "dnes udělej tohle"

SEKCE 6 – KOMUNIKAČNÍ MOSTÍK 💬
- Vzkazy Hanka → Káťa
- Vzkazy Káťa → Hanka
- Co jedna potřebuje vědět od druhé
- Strategické postřehy pro sdílení
Pokud žádné vzkazy: "Žádné nové vzkazy"

SEKCE 7 – KARLOVY POSTŘEHY 🔍
- Vzorce které Karel zaznamenal ale ještě nezařadil
- Hypotézy a intuice (explicitně označené jako hypotézy)
- Propojení mezi částmi/událostmi která si zaslouží pozornost
- Měkká data a dojmy z rozhovorů
[/CENTRUM]

[CENTRUM:04_Mapa_Vztahu]
Nové poznatky o vztazích mezi částmi, změny v dynamice.
[/CENTRUM]

PRAVIDLA PRO CENTRUM:
- Piš POUZE nové informace, které ještě NEJSOU v existujícím dokumentu
- Každý záznam začni datem [YYYY-MM-DD]
- Informace z terapeutických rozhovorů (mamka/kata) jsou PRIMÁRNÍ zdroj pro CENTRUM
- Informace z rozhovorů částí (cast) jsou SEKUNDÁRNÍ – zapiš pouze pokud mění celkový stav systému
- NEVYTVÁŘEJ CENTRUM blok pokud nemáš nové relevantní informace pro daný dokument

Po všech kartách a CENTRUM blocích:
[REPORT]
- ⚠️ TERMINOLOGIE: Rozlišuj přesně:
  • "Zápis do existující karty [jméno]" = karta JIŽ EXISTUJE, pouze jsi zapsal nový obsah
  • "Založena NOVÁ karta [jméno]" = část NEMĚLA kartu, vytvořil jsi novou
  • "Probuzení [jméno] z archivu" = karta existovala v 03_ARCHIV, přesunuta do 01_AKTIVNI
  • "Aktualizace CENTRUM dokumentu [název]" = zapsal nové info do dokumentu v 00_CENTRUM
  NIKDY neříkej "založil jsem kartu" pokud karta již existovala!
- Co bylo změněno (karta + sekce + CENTRUM dokumenty) a proč
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
${centrumDocsContext ? `\nEXISTUJÍCÍ DOKUMENTY 00_CENTRUM (pro deduplikaci – NEPIŠ info které tam už je):\n${centrumDocsContext}` : ""}
${perplexityContext}

═══ ACCOUNTABILITY ENGINE ═══
Na základě seznamu nesplněných úkolů POVINNĚ vygeneruj blok na konci výstupu:

[ACCOUNTABILITY]
SPLNĚNÍ_HANKA: úkol | stav (splněno/nesplněno/neověřeno) | komentář
SPLNĚNÍ_KATA: úkol | stav | komentář
HODNOCENÍ_TÝMU: skóre 1-10, slovní hodnocení
NESPLNĚNÉ_3+_DNÍ: seznam úkolů nesplněných 3+ dny → ESKALACE
POZVÁNKA_NA_PORADU: ano/ne | důvod | navržený formát
[/ACCOUNTABILITY]

Pokud úkol visí 3+ dny, Karel automaticky eskaluje a v emailu svolá "poradu".`,
          },
          { role: "user", content: `${allSummaries}\n\n═══ NESPLNĚNÉ ÚKOLY TERAPEUTŮ ═══\n${pendingTasksSummary || "Žádné nesplněné úkoly"}` },
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
      // Aliases for Amálka + Tonička
      "holky", "holčičky", "holcicky", "děti", "deti", "malé", "male",
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

      // ═══ PROCESS [CENTRUM:...] BLOCKS – Update 00_CENTRUM documents ═══
      let therapeuticPlanContent = ""; // Capture for email inclusion
      if (centrumFolderId) {
        const centrumBlockRegex = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
        const centerFiles = await listFilesInFolder(token, centrumFolderId);
        const dateStr = new Date().toISOString().slice(0, 10);

        for (const match of analysisText.matchAll(centrumBlockRegex)) {
          const docName = match[1].trim();
          const newContent = match[2].trim();
          if (!newContent || newContent.length < 10) continue;

          try {
            const docCanonical = canonicalText(docName);

            // ═══ SPECIAL: 05_Operativni_Plan or 05_Terapeuticky_Plan – FULL DOCUMENT REWRITE ═══
            if ((docCanonical.includes("operativn") && docCanonical.includes("plan")) || (docCanonical.includes("terapeutick") && docCanonical.includes("plan"))) {
              const planFile = centerFiles.find(f => {
                const fc = canonicalText(f.name);
                return (fc.includes("operativn") && fc.includes("plan")) || (fc.includes("terapeutick") && fc.includes("plan"));
              });
              if (!planFile) {
                console.warn(`[CENTRUM] Operative plan doc not found, skipping`);
                continue;
              }

              // Full rewrite – the AI already generated the complete document content
              const planDocument = `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel (vedoucí terapeutického týmu)\n\n${newContent}`;
              therapeuticPlanContent = newContent; // Store for email inclusion
              await updateFileById(token, planFile.id, planDocument, planFile.mimeType);
              cardsUpdated.push(`CENTRUM: 05_Operativni_Plan (kompletní aktualizace)`);
              console.log(`[CENTRUM] ✅ Full rewrite: ${planFile.name}`);
              continue;
            }

            // ═══ SPECIAL: 00_Aktualni_Dashboard – FULL DOCUMENT REWRITE ═══
            if (docCanonical.includes("dashboard") || (docCanonical.includes("aktualn") && docCanonical.includes("dashboard"))) {
              const dashFile = centerFiles.find(f => canonicalText(f.name).includes("dashboard"));
              if (!dashFile) {
                console.warn(`[CENTRUM] Dashboard doc not found, skipping`);
                continue;
              }

              const dashDocument = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${newContent}`;
              await updateFileById(token, dashFile.id, dashDocument, dashFile.mimeType);
              cardsUpdated.push(`CENTRUM: 00_Dashboard (kompletní přepis)`);
              console.log(`[CENTRUM] ✅ Full rewrite: ${dashFile.name}`);
              continue;
            }

            // Find the target document
            let targetFile = centerFiles.find(f => canonicalText(f.name).includes(docCanonical));

            // ═══ SPECIAL: 06_Strategicky_Vyhled – APPEND (not rewrite, weekly does rewrite) ═══
            if (docCanonical.includes("strategick") && docCanonical.includes("vyhled")) {
              const stratFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("strategick"));
              if (stratFile) {
                const existingContent = await readFileContent(token, stratFile.id);
                if (!existingContent.includes(newContent.slice(0, 80))) {
                  const updatedContent = existingContent.trimEnd() + `\n\n[${dateStr}] Denní aktualizace:\n${newContent}`;
                  await updateFileById(token, stratFile.id, updatedContent, stratFile.mimeType);
                  cardsUpdated.push(`CENTRUM: 06_Strategicky_Vyhled (append)`);
                  console.log(`[CENTRUM] ✅ Appended to 06_Strategicky_Vyhled`);
                }
              }
              continue;
            }

            // Handle old 06_Terapeuticke_Dohody → redirect to 05_Operativni_Plan (NEVER create standalone docs)
            if (!targetFile && docCanonical.includes("dohod")) {
              const opPlanFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("operativn"));
              if (opPlanFile) {
                const existingOp = await readFileContent(token, opPlanFile.id);
                if (!existingOp.includes(newContent.slice(0, 80))) {
                  const updatedOp = existingOp.trimEnd() + `\n\n[${dateStr}] Z dohod (denní cyklus):\n${newContent}`;
                  await updateFileById(token, opPlanFile.id, updatedOp, opPlanFile.mimeType);
                  cardsUpdated.push(`CENTRUM: 05_Operativni_Plan (z dohod)`);
                  console.log(`[CENTRUM] ✅ Appended dohody content to 05_Operativni_Plan`);
                }
                continue;
              }
            }

            if (!targetFile) {
              console.warn(`[CENTRUM] Document "${docName}" not found in 00_CENTRUM, skipping`);
              continue;
            }

            // Read existing content for dedup
            const existingContent = await readFileContent(token, targetFile.id);

            if (existingContent.includes(newContent.slice(0, 80))) {
              console.log(`[CENTRUM] Skipping "${docName}" – content already present (dedup)`);
              continue;
            }

            // Append new content with date header
            const updatedContent = existingContent.trimEnd() + `\n\n[${dateStr}] Aktualizace z denního cyklu:\n${newContent}`;
            await updateFileById(token, targetFile.id, updatedContent, targetFile.mimeType);
            cardsUpdated.push(`CENTRUM: ${docName} (aktualizace)`);
            console.log(`[CENTRUM] ✅ Updated: ${targetFile.name}`);
          } catch (e) {
            console.error(`[CENTRUM] Failed to update "${docName}":`, e);
          }
        }
      }

      // ═══ ACCOUNTABILITY: Parse [ACCOUNTABILITY] block and escalate stale tasks ═══
      let accountabilityBlock = "";
      const accountabilityMatch = analysisText.match(/\[ACCOUNTABILITY\]([\s\S]*?)\[\/ACCOUNTABILITY\]/);
      if (accountabilityMatch) {
        accountabilityBlock = accountabilityMatch[1].trim();
        console.log(`[daily-cycle] Accountability block found (${accountabilityBlock.length} chars)`);
        
        // Auto-escalate tasks older than 3 days to high priority
        if (pendingTasks && pendingTasks.length > 0) {
          for (const task of pendingTasks) {
            const age = Math.floor((Date.now() - new Date(task.created_at).getTime()) / (1000*60*60*24));
            if (age >= 3 && task.priority !== "high") {
              await sb.from("did_therapist_tasks").update({ priority: "high" }).eq("task", task.task).eq("assigned_to", task.assigned_to);
              console.log(`[accountability] ⚠️ Escalated task to HIGH: "${task.task}" (${age} days old)`);
            }
          }
        }
      }

      // ═══ 07_KNIHOVNA ANALYSIS: Scan for DID-relevant content and distribute to kartotéka ═══
      try {
        if (centrumFolderId) {
          const centerFiles = await listFilesInFolder(token, centrumFolderId);
          const knihovnaFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && f.name.includes("07_Knihovna"));

          if (knihovnaFolder) {
            const knihovnaFiles = await listFilesInFolder(token, knihovnaFolder.id);
            const prehledFile = knihovnaFiles.find(f => f.name.startsWith("00_Prehled"));

            if (prehledFile) {
              const prehledContent = await readFileContent(token, prehledFile.id);

              // Read all handbook docs (non-folder, non-prehled files)
              const handbookFiles = knihovnaFiles.filter(f =>
                f.mimeType !== DRIVE_FOLDER_MIME && !f.name.startsWith("00_Prehled")
              );

              // Build handbook summaries for AI analysis – skip already distributed ones
              let handbookContext = "";
              const distributedHandbooks: string[] = [];
              const undistributedHandbooks: Array<{ id: string; name: string }> = [];
              const MAX_HANDBOOK_CHARS = 2000;
              for (const hf of handbookFiles.slice(0, 10)) {
                try {
                  const hContent = await readFileContent(token, hf.id);
                  // Skip handbooks already distributed to kartotéka
                  if (hContent.includes("[DISTRIBUOVÁNO DO KARTOTÉKY")) {
                    console.log(`[knihovna] Skipping already distributed: "${hf.name}"`);
                    continue;
                  }
                  handbookContext += `\n\n=== PŘÍRUČKA: ${hf.name} ===\n${hContent.length > MAX_HANDBOOK_CHARS ? hContent.slice(0, MAX_HANDBOOK_CHARS) + "…" : hContent}`;
                  undistributedHandbooks.push({ id: hf.id, name: hf.name });
                } catch {}
              }

              if (handbookContext.length > 100) {
                // AI analysis: determine where handbook content should be distributed
                const knihovnaAnalysisRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: "google/gemini-2.5-flash",
                    messages: [
                      {
                        role: "system",
                        content: `Jsi Karel – analytik DID systému. Tvým úkolem je projít příručky uložené v 07_Knihovna a pro KAŽDOU příručku, která se JAKKOLIV týká DID systému, určit KAM v kartotéce by měly být informace zapsány.

═══ CO JE DID-RELEVANTNÍ ═══
- Metoda/technika použitelná pro konkrétní fragment/část (např. hra pro dětskou část, stabilizační technika)
- Obecná terapeutická metoda pro DID (senzorická integrace, projektivní techniky, sandtray)
- Výzkum relevantní pro práci s DID systémem
- Článek o traumatu, disociaci, attachment teorii
- Plánované sezení s konkrétní částí

═══ KAM ZAPSAT ═══
Pro každou DID-relevantní příručku vypiš záznamy v tomto formátu:

[KNIHOVNA_KARTA:jméno_části]
Stručné shrnutí co je relevantní pro tuto část. Odkaz: viz příručka "název příručky" v 07_Knihovna.
Sekce kam zapsat (I = metody, J = krátkodobé cíle, G = deník sezení pokud je sezení plánováno brzy):
[SEKCE:I] Konkrétní metoda z příručky – stručný popis, odkaz na příručku
[SEKCE:J] Plán na sezení / krátkodobý cíl – pokud vyplývá z příručky
[/KNIHOVNA_KARTA]

[KNIHOVNA_CENTRUM:05_Terapeuticky_Plan_Aktualni]
Informace relevantní pro terapeutický plán – stručně, s odkazem na příručku.
[/KNIHOVNA_CENTRUM]

[KNIHOVNA_CENTRUM:06_Terapeuticke_Dohody]
Informace pro dohody – jen pokud jde o dlouhodobý směr/plán.
[/KNIHOVNA_CENTRUM]

[KNIHOVNA_CENTRUM:00_Aktualni_Dashboard]
Informace pro dashboard – jen pokud je něco urgentní nebo nového k pozornosti.
[/KNIHOVNA_CENTRUM]

═══ PRAVIDLA ═══
- NIKDY nevkládej celý obsah příručky – jen stručné shrnutí + odkaz na příručku v 07_Knihovna
- Formát odkazu: "Viz příručka: [název příručky] v 07_Knihovna"
- Pokud příručka NENÍ DID-relevantní, ignoruj ji
- Buď inteligentní: rozliš zda je sezení plánováno na příští dny (→ sekce J krátkodobé) nebo obecně v budoucnu (→ sekce H dlouhodobé, nebo 06_Dohody)
- Pokud je příručka o konkrétní části, zapiš do karty té části
- Pokud je obecnější, zapiš do plánu/dohod
- Pokud nemáš jistotu o existenci karty, zmíň to v [KNIHOVNA_CENTRUM:05_Terapeuticky_Plan_Aktualni]

${existingCardsContext ? `\nEXISTUJÍCÍ KARTY (pro ověření existence částí):\n${existingCardsContext.slice(0, 3000)}` : ""}`,
                      },
                      {
                        role: "user",
                        content: `PŘEHLED KNIHOVNY (00_Prehled):\n${prehledContent.slice(0, 2000)}\n\nPŘÍRUČKY:\n${handbookContext}`,
                      },
                    ],
                  }),
                });

                if (knihovnaAnalysisRes.ok) {
                  const knihovnaData = await knihovnaAnalysisRes.json();
                  const knihovnaText = knihovnaData.choices?.[0]?.message?.content || "";

                  if (knihovnaText.length > 50) {
                    console.log(`[knihovna] AI analysis: ${knihovnaText.length} chars`);

                    // Process [KNIHOVNA_KARTA:...] blocks → write to cards
                    const kartaRegex = /\[KNIHOVNA_KARTA:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_KARTA\]/g;
                    for (const km of knihovnaText.matchAll(kartaRegex)) {
                      const partName = km[1].trim();
                      const block = km[2].trim();

                      // Skip blacklisted names
                      if (isBlacklisted(partName)) continue;

                      const sectionRegex = /\[SEKCE:([A-M])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
                      const newSections: Record<string, string> = {};
                      for (const sm of block.matchAll(sectionRegex)) {
                        const content = sm[2].trim();
                        if (content) newSections[sm[1].toUpperCase()] = content;
                      }

                      if (Object.keys(newSections).length > 0) {
                        try {
                          const target = await resolveCardTarget(token, folderId!, partName, registryContext);
                          if (target.registryEntry) {
                            const probeCard = await findCardFile(token, target.registryEntry.name || partName, target.searchRootId);
                            if (probeCard) {
                              const result = await updateCardSections(
                                token, target.registryEntry.name || partName, newSections, target.searchRootId,
                                { searchName: target.registryEntry.name || partName, canonicalPartName: target.registryEntry.name || partName, registryContext }
                              );
                              cardsUpdated.push(`${partName} (z 07_Knihovna: ${result.sectionsUpdated.join(",")})`);
                              console.log(`[knihovna] ✅ Card ${partName}: sections ${result.sectionsUpdated.join(",")}`);
                            }
                          }
                        } catch (e) {
                          console.warn(`[knihovna] Card update failed for ${partName}:`, e);
                        }
                      }
                    }

                    // Process [KNIHOVNA_CENTRUM:...] blocks → append to CENTRUM docs
                    const centrumRegex = /\[KNIHOVNA_CENTRUM:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_CENTRUM\]/g;
                    for (const cm of knihovnaText.matchAll(centrumRegex)) {
                      const docName = cm[1].trim();
                      const newContent = cm[2].trim();
                      if (!newContent || newContent.length < 10) continue;

                      try {
                        const docCanonical = canonicalText(docName);
                        const targetFile = centerFiles.find(f => {
                          const fc = canonicalText(f.name);
                          if (docCanonical.includes("plan") && docCanonical.includes("terapeutick")) return fc.includes("terapeutick") && fc.includes("plan");
                          if (docCanonical.includes("dashboard")) return fc.includes("dashboard");
                          if (docCanonical.includes("dohod")) return fc.includes("dohod");
                          return fc.includes(docCanonical);
                        });

                        if (targetFile) {
                          if (targetFile.mimeType === DRIVE_FOLDER_MIME) {
                            // Folder (e.g. old 06_Dohody) → redirect to 05_Operativni_Plan, NEVER create standalone doc
                            const opFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("operativn"));
                            if (opFile) {
                              const existingOp = await readFileContent(token, opFile.id);
                              if (!existingOp.includes(newContent.slice(0, 60))) {
                                const updatedOp = existingOp.trimEnd() + `\n\n[${new Date().toISOString().slice(0, 10)}] Z 07_Knihovna:\n${newContent}`;
                                await updateFileById(token, opFile.id, updatedOp, opFile.mimeType);
                              }
                            }
                          } else {
                            const existing = await readFileContent(token, targetFile.id);
                            if (!existing.includes(newContent.slice(0, 60))) {
                              const updated = existing.trimEnd() + `\n\n[${new Date().toISOString().slice(0, 10)}] Z 07_Knihovna:\n${newContent}`;
                              await updateFileById(token, targetFile.id, updated, targetFile.mimeType);
                            }
                          }
                          cardsUpdated.push(`CENTRUM: ${docName} (z 07_Knihovna)`);
                          console.log(`[knihovna] ✅ CENTRUM ${docName} updated from 07_Knihovna`);
                        }
                      } catch (e) {
                        console.warn(`[knihovna] CENTRUM update failed for ${docName}:`, e);
                      }
                    }
                  }

                  // Mark all undistributed handbooks as processed by appending marker
                  const distribDateStr = new Date().toISOString().slice(0, 10);
                  for (const uh of undistributedHandbooks) {
                    try {
                      await appendToDoc(token, uh.id, `\n\n[DISTRIBUOVÁNO DO KARTOTÉKY: ${distribDateStr}]`);
                      console.log(`[knihovna] Marked as distributed: "${uh.name}"`);
                    } catch (markErr) {
                      console.warn(`[knihovna] Failed to mark "${uh.name}" as distributed:`, markErr);
                    }
                  }
                } else {
                  console.warn(`[knihovna] AI analysis failed: ${knihovnaAnalysisRes.status}`);
                }
              }
            }
          }
        }
      } catch (knihovnaErr) {
        console.warn("[knihovna] 07_Knihovna analysis error (non-fatal):", knihovnaErr);
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
      const dateStr = reportDatePrague;

      // 5. SEPARATE EMAILS FOR HANKA AND KÁŤA – ONLY from cron
      let hankaHtml = "";
      let kataHtml = "";
      if (shouldSendEmails && resend && finalReportText) {
        try {
          // Load motivation profiles for adaptive tone
          let hankaProfile: any = null;
          let kataProfile: any = null;
          try {
            const { data: profiles } = await sb.from("did_motivation_profiles").select("*");
            if (profiles) {
              hankaProfile = profiles.find((p: any) => p.therapist === "Hanka");
              kataProfile = profiles.find((p: any) => p.therapist === "Káťa");
            }
          } catch {}

          const formatProfileContext = (p: any) => {
            if (!p) return "Žádný profil zatím.";
            return `Splněno: ${p.tasks_completed}, Nesplněno: ${p.tasks_missed}, Průměr dokončení: ${p.avg_completion_days} dní, Série: ${p.streak_current} (max ${p.streak_best}), Preferovaný styl: ${p.preferred_style}`;
          };

          // Generate personalized reports using AI
          const partsSummary = successfulCardUpdates.map(s => s.partName).join(", ") || "žádné";
          const blockedSummary = blockedCardUpdates.map(b => b.partName).join(", ");

          // HANKA's report (intimate, full detail, partner tone)
          hankaHtml = "";
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

<h3>📋 OPERATIVNÍ PLÁN – KLÍČOVÉ BODY:</h3>
Shrň 5-8 nejdůležitějších bodů z operativního plánu:
▸ Krátkodobé cíle a aktivní úkoly
▸ S jakými fragmenty dnes/zítra pracovat a jak
▸ Co zkontrolovat / co bylo odloženo
▸ Aktuální doporučení a návrhy metod

<h3>📋 HODNOCENÍ SPOLUPRÁCE:</h3>
Na základě accountability dat uveď:
▸ Co bylo splněno (pochvala)
▸ Co nebylo splněno (laskavě ale důsledně)
▸ Přímé otázky: "Hani, jak dopadlo [konkrétní úkol]?"

Pokud existují úkoly nesplněné 3+ dny, přidej sekci:
<h3>📋 KAREL SVOLÁVÁ PORADU</h3>
Téma: [problém]
Proč: [co Karel pozoruje]
Co Karel navrhuje: [řešení]

Podpis: "Jsem tady. Tvůj Karel"

Tón: intimní, partnerský, podporující, hluboký.
ADAPTIVNÍ STYL: Přizpůsob tón na základě motivačního profilu. Pokud je styl "praise" → více pochval a uznání. Pokud "deadline" → více konkrétních termínů. Pokud "instruction" → více detailních kroků.` },
                  { role: "user", content: `Dnešní data:\n${finalReportText}\n\nAI doporučení:\n${aiReportText}${therapeuticPlanContent ? `\n\n═══ OPERATIVNÍ PLÁN (aktuální verze) ═══\n${therapeuticPlanContent}` : ""}${accountabilityBlock ? `\n\n═══ ACCOUNTABILITY ═══\n${accountabilityBlock}` : ""}\n\n═══ MOTIVAČNÍ PROFIL HANKY ═══\n${formatProfileContext(hankaProfile)}` },
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

<h3>📋 OPERATIVNÍ PLÁN – KLÍČOVÉ BODY PRO KÁŤU:</h3>
Shrň 4-6 bodů relevantních pro Kátinu roli:
▸ Konkrétní úkoly pro Káťu
▸ S jakými fragmenty pracovat a jak
▸ Aktuální doporučení

<h3>📋 HODNOCENÍ SPOLUPRÁCE:</h3>
▸ Co Káťa splnila (pochvala)
▸ Co zbývá (přímé otázky: "Káťo, jak jsi pokročila s [úkol]?")

Podpis: "Karel"

DŮLEŽITÉ: NEPOUŽÍVEJ intimní tón. Pouze profesionální respekt. Nesdílej Hančiny osobní informace.
ADAPTIVNÍ STYL: Přizpůsob tón na základě motivačního profilu. Pokud je styl "praise" → více pochval. Pokud "deadline" → více termínů. Pokud "instruction" → detailní kroky.` },
                  { role: "user", content: `Dnešní data:\n${finalReportText}\n\nAI doporučení:\n${aiReportText}${therapeuticPlanContent ? `\n\n═══ OPERATIVNÍ PLÁN (aktuální verze) ═══\n${therapeuticPlanContent}` : ""}${accountabilityBlock ? `\n\n═══ ACCOUNTABILITY ═══\n${accountabilityBlock}` : ""}\n\n═══ MOTIVAČNÍ PROFIL KÁTI ═══\n${formatProfileContext(kataProfile)}` },
                ],
              }),
            });
            if (kataRes.ok) {
              const d = await kataRes.json();
              kataHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
            }
          } catch {}
          if (!kataHtml) kataHtml = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${finalReportText}</pre>`;

          emailSentToHanka = await sendEmailOnce(
            "hanka",
            MAMKA_EMAIL,
            `Karel – denní report ${dateStr}`,
            hankaHtml,
          );
          if (emailSentToHanka) {
            console.log(`Daily report sent to Hanka: ${MAMKA_EMAIL}`);
          }

          emailSentToKata = await sendEmailOnce(
            "kata",
            KATA_EMAIL,
            `Karel – report pro Káťu ${dateStr}`,
            kataHtml,
          );
          if (emailSentToKata) {
            console.log(`Daily report sent to Káťa: ${KATA_EMAIL}`);
          }
        } catch (e) { console.error("Email send error:", e); }
      }
    }

    // ═══ AUTO-CREATE MEETING if Karel calls one in the reports ═══
    try {
      const combinedReportText = (hankaHtml || "") + " " + (kataHtml || "") + " " + aiReportText;
      const meetingMatch = combinedReportText.match(/KAREL SVOL[ÁA]V[ÁA] PORADU/i);
      if (meetingMatch && shouldSendEmails) {
        // Extract topic from report
        const topicMatch = combinedReportText.match(/KAREL SVOL[ÁA]V[ÁA] PORADU[\s\S]*?[Tt][ée]ma:\s*([^\n<]+)/i);
        const whyMatch = combinedReportText.match(/KAREL SVOL[ÁA]V[ÁA] PORADU[\s\S]*?[Pp]ro[čc]:\s*([^\n<]+)/i);
        const proposalMatch = combinedReportText.match(/KAREL SVOL[ÁA]V[ÁA] PORADU[\s\S]*?[Cc]o Karel navrhuje:\s*([^\n<]+)/i);
        
        const meetingTopic = topicMatch?.[1]?.trim() || "Porada svolaná Karlem";
        const meetingAgenda = [
          whyMatch?.[1]?.trim() ? `Proč: ${whyMatch[1].trim()}` : "",
          proposalMatch?.[1]?.trim() ? `Návrh: ${proposalMatch[1].trim()}` : "",
        ].filter(Boolean).join("\n");

        // Create meeting via the meeting function
        try {
          const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
          const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
          const meetingResp = await fetch(`${SUPABASE_URL}/functions/v1/karel-did-meeting`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              action: "create",
              message: meetingTopic,
              therapist: meetingAgenda,
            }),
          });
          if (meetingResp.ok) {
            console.log(`[daily-cycle] ✅ Auto-created meeting: "${meetingTopic}"`);
          } else {
            console.warn(`[daily-cycle] Meeting creation failed: ${meetingResp.status}`);
          }
        } catch (meetErr) {
          console.warn("[daily-cycle] Meeting auto-create error:", meetErr);
        }
      }
    } catch (meetingErr) {
      console.warn("[daily-cycle] Meeting detection error (non-fatal):", meetingErr);
    }

    // Card update failures are tracked separately in did_update_cycles
    const threadIds = threads.map(t => t.id);
    if (threadIds.length > 0) {
      await sb.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", threadIds);
    }
    const convIds = conversations.map(c => c.id);
    if (convIds.length > 0) {
      await sb.from("did_conversations").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", convIds);
    }

    // ═══ FLUSH PENDING DRIVE WRITES ═══
    try {
      const { data: pendingWrites } = await sb.from("did_pending_drive_writes")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(50);

      if (pendingWrites && pendingWrites.length > 0 && folderId) {
        console.log(`[daily-cycle] Flushing ${pendingWrites.length} pending Drive writes`);
        const centrumId = await findFolder(token, "00_CENTRUM");
        if (centrumId) {
          const centerFiles = await listFilesInFolder(token, centrumId);
          for (const pw of pendingWrites) {
            try {
              const targetFile = centerFiles.find(f =>
                f.mimeType !== DRIVE_FOLDER_MIME &&
                canonicalText(f.name).includes(canonicalText(pw.target_document))
              );
              if (targetFile) {
                const existing = await readFileContent(token, targetFile.id);
                if (!existing.includes(pw.content.slice(0, 60))) {
                  const dateStr = new Date().toISOString().slice(0, 10);
                  const updated = existing.trimEnd() + `\n\n[${dateStr}] Nový úkol z nástěnky:\n${pw.content}`;
                  await updateFileById(token, targetFile.id, updated, targetFile.mimeType);
                  console.log(`[pending-write] ✅ Flushed to ${pw.target_document}`);
                }
              }
              await sb.from("did_pending_drive_writes").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", pw.id);
            } catch (pwErr) {
              console.warn(`[pending-write] Failed for ${pw.id}:`, pwErr);
              await sb.from("did_pending_drive_writes").update({ status: "failed" }).eq("id", pw.id);
            }
          }
        }
      }
    } catch (flushErr) {
      console.warn("[daily-cycle] Pending writes flush error (non-fatal):", flushErr);
    }

    // ═══ ESCALATION LOGIC: 3-tier escalation for stale tasks (4/5/7 days) ═══
    try {
      const { data: allTasks } = await sb.from("did_therapist_tasks")
        .select("id, task, assigned_to, status, status_hanka, status_kata, created_at, escalation_level, category")
        .neq("status", "done");

      if (allTasks && allTasks.length > 0) {
        const now = Date.now();
        for (const t of allTasks) {
          const ageDays = (now - new Date(t.created_at).getTime()) / (24 * 60 * 60 * 1000);
          const currentLevel = t.escalation_level || 0;
          let newLevel = currentLevel;

          // Level 1: gentle reminder after 4 days
          if (ageDays >= 4 && currentLevel < 1) newLevel = 1;
          // Level 2: direct question after 5 days
          if (ageDays >= 5 && currentLevel < 2) newLevel = 2;
          // Level 3: meeting proposal after 7 days
          if (ageDays >= 7 && currentLevel < 3) newLevel = 3;

          if (newLevel > currentLevel) {
            await sb.from("did_therapist_tasks").update({
              escalation_level: newLevel,
              priority: newLevel >= 2 ? "high" : t.priority || "normal",
              updated_at: new Date().toISOString(),
            }).eq("id", t.id);
            console.log(`[escalation] Task "${t.task.slice(0, 40)}" escalated to level ${newLevel}`);
          }
        }

        // Update motivation profiles for missed tasks (4+ days old, not done)
        const staleTasks = allTasks.filter(t => {
          const age = (now - new Date(t.created_at).getTime()) / (24 * 60 * 60 * 1000);
          return age >= 4;
        });
        for (const st of staleTasks) {
          const therapists: string[] = [];
          if ((st.assigned_to === "hanka" || st.assigned_to === "both") && st.status_hanka !== "done") therapists.push("Hanka");
          if ((st.assigned_to === "kata" || st.assigned_to === "both") && st.status_kata !== "done") therapists.push("Káťa");
          for (const therapist of therapists) {
            // Only mark missed once per escalation bump
            if ((st.escalation_level || 0) < 1) {
              const { data: profile } = await sb.from("did_motivation_profiles").select("*").eq("therapist", therapist).maybeSingle();
              if (profile) {
                await sb.from("did_motivation_profiles").update({
                  tasks_missed: (profile.tasks_missed || 0) + 1,
                  streak_current: 0,
                  updated_at: new Date().toISOString(),
                }).eq("id", profile.id);
              }
            }
          }
        }
      }
    } catch (escErr) {
      console.warn("[daily-cycle] Escalation logic error (non-fatal):", escErr);
    }

    // ═══ AUTO-CLEANUP: remove old duplicates and completed tasks from therapist task board ═══
    try {
      // 1. Remove tasks completed (both statuses "done") more than 14 days ago
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      await sb.from("did_therapist_tasks")
        .delete()
        .eq("status", "done")
        .lt("completed_at", fourteenDaysAgo);

      // 2. Remove exact duplicate tasks (same task text, same assigned_to, same status, keep newest)
      const { data: allTasksCleanup } = await sb.from("did_therapist_tasks")
        .select("id, task, assigned_to, status, created_at")
        .order("created_at", { ascending: false });

      if (allTasksCleanup && allTasksCleanup.length > 0) {
        const seen = new Set<string>();
        const dupeIds: string[] = [];
        for (const t of allTasksCleanup) {
          const key = `${t.task.trim().toLowerCase()}|${t.assigned_to}`;
          if (seen.has(key)) {
            dupeIds.push(t.id);
          } else {
            seen.add(key);
          }
        }
        if (dupeIds.length > 0) {
          await sb.from("did_therapist_tasks").delete().in("id", dupeIds);
          console.log(`[daily-cycle] Cleaned up ${dupeIds.length} duplicate therapist tasks`);
        }
      }
    } catch (cleanupErr) {
      console.warn("[daily-cycle] Task cleanup error (non-fatal):", cleanupErr);
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
      reportSent: emailSentToHanka || emailSentToKata,
      processingRetained: hadCardUpdateErrors,
      message: hadCardUpdateErrors
        ? "Aktualizace některých karet selhala – konverzace zůstaly neoznačené pro další pokus."
        : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Daily cycle error:", error);

    if (sb && cycleId) {
      try {
        await sb.from("did_update_cycles").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          report_summary: `ERROR: ${error instanceof Error ? error.message.slice(0, 1800) : "Unknown error"}`,
        }).eq("id", cycleId);
      } catch (cycleUpdateErr) {
        console.error("[daily-cycle] Failed to mark cycle as failed:", cycleUpdateErr);
      }
    }

    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
