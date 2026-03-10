import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import * as XLSX from "npm:xlsx@0.18.5";

// ═══════════════════════════════════════════════════════
// CORE RULE: NEVER create standalone files as substitutes
// for writing into existing documents. ALWAYS find the
// existing target document first, then append/insert.
// ═══════════════════════════════════════════════════════

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

// ── Constants ──
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLS_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

// ── Text helpers ──
const stripDiacritics = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const canonicalText = (v: string) =>
  stripDiacritics(v || "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

function scoreNameMatch(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 10;
  if (left.includes(right) || right.includes(left)) return 7;
  if (left.slice(0, 6) === right.slice(0, 6)) return 3;
  return 0;
}

// ── Drive helpers (with Shared Drive support) ──
type DriveFile = { id: string; name: string; mimeType?: string };

async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
  const params = new URLSearchParams({
    q, fields: "files(id)", pageSize: "50",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return allFiles;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

// ── Google Docs in-place update (preserves file ID & history) ──
async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) throw new Error(`Docs read failed (${docRes.status}): ${await docRes.text()}`);

  const docData = await docRes.json();
  const bodyContent = docData?.body?.content || [];
  const lastEndIndex = bodyContent.length > 0
    ? Number(bodyContent[bodyContent.length - 1]?.endIndex || 1) : 1;

  const requests: any[] = [];
  if (lastEndIndex > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: lastEndIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: content } });

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!updateRes.ok) throw new Error(`Docs batchUpdate failed (${updateRes.status}): ${await updateRes.text()}`);
}

// ── Update file by ID (Google Doc or plain text) ──
async function updateFileById(token: string, fileId: string, content: string, mimeType?: string): Promise<any> {
  if (mimeType === DRIVE_DOC_MIME) {
    try {
      await updateGoogleDocInPlace(token, fileId, content);
      return { id: fileId, updatedInPlace: true };
    } catch (e) {
      console.warn(`[updateFileById] Docs API failed for ${fileId}, falling back to Drive PATCH: ${e}`);
      const boundary = "----DIDWriteBoundary";
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
  const boundary = "----DIDWriteBoundary";
  const metadata = JSON.stringify({});
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed for ${fileId}: ${await res.text()}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----DIDWriteBoundary";
  // Create as Google Doc (not .txt) by specifying mimeType
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed for ${fileName}: ${await res.text()}`);
  return await res.json();
}

// ═══ REGISTRY ═══
interface RegistryEntry {
  id: string; name: string; status: string; cluster: string; note: string; normalizedName: string;
}
interface RegistryContext {
  entries: RegistryEntry[];
  activeFolderId: string | null;
  archiveFolderId: string | null;
  clusterFolderId: string | null;
  centerFolderId: string | null;
  agreementsFolderId: string | null;
}

function parseRegistryEntries(rows: string[][]): RegistryEntry[] {
  const nonEmpty = rows.filter(r => r.some(c => `${c ?? ""}`.trim().length > 0));
  if (nonEmpty.length === 0) return [];
  let headerIdx = nonEmpty.findIndex((row, idx) => {
    if (idx > 10) return false;
    const norm = row.map(c => canonicalText(String(c)));
    return norm.some(c => ["id", "cislo", "number"].some(v => c.includes(v)))
      && norm.some(c => ["jmeno", "nazev", "cast", "part", "fragment"].some(v => c.includes(v)));
  });
  if (headerIdx < 0) headerIdx = 0;
  const header = nonEmpty[headerIdx].map(c => canonicalText(String(c)));
  const findCol = (hints: string[], fb: number) => { const i = header.findIndex(h => hints.some(v => h.includes(v))); return i >= 0 ? i : fb; };
  const idCol = findCol(["id", "cislo", "number"], 0);
  const nameCol = findCol(["jmeno", "nazev", "cast", "part", "fragment"], 1);
  const statusCol = findCol(["stav", "status"], 2);
  const clusterCol = findCol(["klastr", "cluster"], 3);
  const noteCol = findCol(["poznam", "note", "komentar"], 4);
  const entries: RegistryEntry[] = [];
  for (const row of nonEmpty.slice(headerIdx + 1)) {
    const rawName = String(row[nameCol] ?? "").trim();
    if (!rawName) continue;
    const rawId = String(row[idCol] ?? "").trim();
    const idMatch = rawId.match(/\d{1,4}/);
    const id = idMatch ? idMatch[0].padStart(3, "0") : "";
    const normalizedName = canonicalText(rawName);
    if (!normalizedName) continue;
    entries.push({ id, name: rawName, status: String(row[statusCol] ?? "").trim(), cluster: String(row[clusterCol] ?? "").trim(), note: String(row[noteCol] ?? "").trim(), normalizedName });
  }
  return entries;
}

async function readRegistryRows(token: string, file: DriveFile): Promise<string[][]> {
  let workbook: XLSX.WorkBook;
  if (file.mimeType === DRIVE_SHEET_MIME) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Registry export failed (${exportRes.status})`);
    workbook = XLSX.read(await exportRes.text(), { type: "string" });
  } else {
    const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!mediaRes.ok) throw new Error(`Registry download failed (${mediaRes.status})`);
    workbook = XLSX.read(new Uint8Array(await mediaRes.arrayBuffer()), { type: "array" });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][]).map(r => r.map(c => `${c ?? ""}`.trim()));
}

async function loadRegistryContext(token: string, rootFolderId: string): Promise<RegistryContext> {
  const rootChildren = await listFilesInFolder(token, rootFolderId);
  const rootFolders = rootChildren.filter(f => f.mimeType === DRIVE_FOLDER_MIME);
  const pick = (pred: (c: string, r: string) => boolean) => rootFolders.find(f => pred(canonicalText(f.name), f.name))?.id || null;

  const centerFolderId = pick((c, r) => /^00/.test(r.trim()) || c.includes("centrum"));
  const activeFolderId = pick((c, r) => /^01/.test(r.trim()) || c.includes("aktiv"));
  const clusterFolderId = pick((c, r) => /^02/.test(r.trim()) || c.includes("klastr") || c.includes("rodokmen"));
  const archiveFolderId = pick((c, r) => /^03/.test(r.trim()) || (c.includes("archiv") && /spic|spis/.test(c)));

  // Find 06_Terapeuticke_Dohody subfolder inside 00_CENTRUM
  let agreementsFolderId: string | null = null;
  if (centerFolderId) {
    const centerFiles = await listFilesInFolder(token, centerFolderId);
    const agFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^06/.test(f.name.trim()) || canonicalText(f.name).includes("dohod")));
    agreementsFolderId = agFolder?.id || null;
  }

  if (!centerFolderId) {
    console.warn("[registry] 00_CENTRUM folder not found");
    return { entries: [], activeFolderId, archiveFolderId, clusterFolderId, centerFolderId, agreementsFolderId };
  }

  const centerFiles = await listFilesInFolder(token, centerFolderId);
  const registryCandidates = centerFiles
    .filter(f => f.mimeType === DRIVE_SHEET_MIME || XLS_MIME_TYPES.has(f.mimeType || "") || /\.xlsx?$/.test(f.name.toLowerCase()))
    .map(file => {
      const c = canonicalText(file.name);
      let score = 0;
      if (c.includes("01indexvsechcasti")) score += 10;
      else if (c.includes("indexvsechcasti")) score += 7;
      else if (c.includes("index") && c.includes("cast")) score += 4;
      if (file.mimeType === DRIVE_SHEET_MIME) score += 1;
      return { file, score };
    }).sort((a, b) => b.score - a.score);

  const registryFile = registryCandidates[0]?.file;
  if (!registryFile) {
    console.warn("[registry] Registry spreadsheet not found");
    return { entries: [], activeFolderId, archiveFolderId, clusterFolderId, centerFolderId, agreementsFolderId };
  }

  const rows = await readRegistryRows(token, registryFile);
  const entries = parseRegistryEntries(rows);
  console.log(`[registry] Loaded ${entries.length} entries from ${registryFile.name}`);
  return { entries, activeFolderId, archiveFolderId, clusterFolderId, centerFolderId, agreementsFolderId };
}

function isArchivedFromRegistry(entry: RegistryEntry): boolean {
  const sc = canonicalText(entry.status || "");
  if (/^(spi|spic|spis|sleep|dormant|archiv|neaktiv|usp|hibern)/.test(sc)) return true;
  if (/^(aktiv|active|probuzen|awake|online)/.test(sc)) return false;
  const combined = canonicalText(`${entry.status} ${entry.cluster} ${entry.note}`);
  if (/(spic|spis|spi|sleep|dormant|archiv|neaktiv|uspany|uspavana)/.test(combined)) return true;
  return false;
}

function findBestRegistryEntry(partName: string, entries: RegistryEntry[]): RegistryEntry | null {
  const cp = canonicalText(partName);
  if (!cp) return null;
  const scored = entries.map(e => ({ entry: e, score: scoreNameMatch(cp, e.normalizedName) })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.entry || null;
}

async function findBestPartFolder(token: string, stateFolderId: string, entry: RegistryEntry): Promise<DriveFile | null> {
  const files = await listFilesInFolder(token, stateFolderId);
  const folders = files.filter(f => f.mimeType === DRIVE_FOLDER_MIME);
  const idPrefixRegex = entry.id ? new RegExp(`^0*${Number(entry.id)}(?:[_\\s-]|$)`) : null;
  const scored = folders.map(folder => {
    let score = scoreNameMatch(entry.normalizedName, canonicalText(folder.name));
    if (idPrefixRegex && idPrefixRegex.test(folder.name)) score += 8;
    if (entry.id && canonicalText(folder.name).includes(entry.id)) score += 2;
    return { folder, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.folder || null;
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
  lines.push(sections["_preamble"] || `KARTA ČÁSTI: ${partName.toUpperCase()}`);
  lines.push("");
  for (const letter of SECTION_ORDER) {
    lines.push(sectionHeader(letter));
    lines.push(sections[letter] || "(zatím prázdné)");
    lines.push("");
  }
  return lines.join("\n");
}

interface CardFileResult {
  fileId: string; fileName: string; content: string; parentFolderId: string; mimeType?: string;
}

async function findCardFile(token: string, partName: string, rootFolderId: string): Promise<CardFileResult | null> {
  const normalizedPart = canonicalText(partName);
  async function searchFolder(folderId: string): Promise<CardFileResult | null> {
    const files = await listFilesInFolder(token, folderId);
    const matches: Array<{ file: DriveFile; priority: number }> = [];
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER_MIME) continue;
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      if (scoreNameMatch(normalizedPart, canonicalText(baseName)) > 0) {
        const isKartaTxt = /^karta_/i.test(f.name) && /\.txt$/i.test(f.name);
        const priority = f.mimeType === DRIVE_DOC_MIME ? 0 : isKartaTxt ? 2 : 1;
        matches.push({ file: f, priority });
      }
    }
    matches.sort((a, b) => a.priority - b.priority);
    for (const { file: f } of matches) {
      try {
        const content = await readFileContent(token, f.id);
        console.log(`[findCardFile] Found "${partName}": ${f.name} (${f.id}) mimeType=${f.mimeType}`);
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

// Find a specific document by name pattern in a folder (for Dashboard, Therapy Plan, etc.)
async function findDocumentByPattern(token: string, folderId: string, patterns: string[]): Promise<CardFileResult | null> {
  const files = await listFilesInFolder(token, folderId);
  for (const pattern of patterns) {
    const cp = canonicalText(pattern);
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER_MIME) continue;
      if (scoreNameMatch(cp, canonicalText(f.name)) > 0) {
        try {
          const content = await readFileContent(token, f.id);
          return { fileId: f.id, fileName: f.name, content, parentFolderId: folderId, mimeType: f.mimeType };
        } catch (e) { console.error(`Cannot read ${f.name}:`, e); }
      }
    }
  }
  return null;
}

// ═══ RESOLVE where a card should be written ═══
interface CardTarget {
  searchRootId: string;
  allowCreate: boolean;
  pathLabel: string;
  registryEntry: RegistryEntry | null;
}

function resolveCardTarget(
  partName: string,
  rootFolderId: string,
  registry: RegistryContext,
  partFolder: DriveFile | null,
  isArchived: boolean
): CardTarget {
  const entry = findBestRegistryEntry(partName, registry.entries);

  if (!entry) {
    const root = registry.activeFolderId || rootFolderId;
    return { searchRootId: root, allowCreate: true, pathLabel: "01_AKTIVNI_FRAGMENTY/(nová část)", registryEntry: null };
  }

  const stateFolderId = isArchived ? registry.archiveFolderId : registry.activeFolderId;
  if (!stateFolderId) {
    throw new Error(`Registry matched "${entry.name}" but state folder missing (${isArchived ? "archive" : "active"})`);
  }

  return {
    searchRootId: partFolder?.id || stateFolderId,
    allowCreate: false,
    pathLabel: `${isArchived ? "03_ARCHIV" : "01_AKTIVNI"}/${partFolder?.name || "(root)"}`,
    registryEntry: entry,
  };
}

// ═══ MAIN SERVER ═══
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const body = await req.json();
    const token = await getAccessToken();

    // Find Kartoteka_DID folder
    const folderId = await findFolder(token, "Kartoteka_DID")
      || await findFolder(token, "Kartotéka_DID")
      || await findFolder(token, "KARTOTEKA_DID");

    if (!folderId) {
      return new Response(JSON.stringify({ error: "Kartoteka_DID folder not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load registry for all modes
    let registry: RegistryContext | null = null;
    try {
      registry = await loadRegistryContext(token, folderId);
      console.log(`[registry] Loaded: ${registry.entries.length} entries, active=${registry.activeFolderId}, archive=${registry.archiveFolderId}, center=${registry.centerFolderId}`);
    } catch (e) {
      console.error("[registry] Failed to load:", e);
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    // ═══════════════════════════════════════════════════════
    // MODE A: "update-card-sections" - DID Part Card (A-M)
    // Location: 01_AKTIVNI_FRAGMENTY/ or 03_ARCHIV_SPICICH/
    // ═══════════════════════════════════════════════════════
    if (body.mode === "update-card-sections") {
      const { partName, sections: newSections } = body;
      if (!partName || !newSections) {
        return new Response(JSON.stringify({ error: "partName and sections required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!registry) {
        return new Response(JSON.stringify({ error: "Registry not available - cannot safely resolve card location" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const entry = findBestRegistryEntry(partName, registry.entries);
      const isArchived = entry ? isArchivedFromRegistry(entry) : false;
      let partFolder: DriveFile | null = null;
      if (entry) {
        const stateFolderId = isArchived ? registry.archiveFolderId : registry.activeFolderId;
        if (stateFolderId) partFolder = await findBestPartFolder(token, stateFolderId, entry);
      }

      const target = resolveCardTarget(partName, folderId, registry, partFolder, isArchived);
      const lookupName = target.registryEntry?.name || partName;
      const card = await findCardFile(token, lookupName, target.searchRootId);

      // ═══ FAIL-SAFE: registry match but card not found → BLOCK ═══
      if (!card && target.registryEntry) {
        const msg = `FAIL-SAFE: "${lookupName}" (ID: ${target.registryEntry.id}) exists in registry but card NOT found in ${target.pathLabel}. Write BLOCKED.`;
        console.error(msg);
        return new Response(JSON.stringify({
          error: msg,
          failSafe: true,
          registryEntry: target.registryEntry,
          searchedIn: target.pathLabel,
        }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let existingSections: Record<string, string>;
      let isNew = false;

      if (card) {
        existingSections = parseCardSections(card.content);
        console.log(`[update-card-sections] Found: ${card.fileName} (${card.fileId}), mimeType=${card.mimeType}`);
      } else {
        if (!target.allowCreate) {
          return new Response(JSON.stringify({ error: `Card for "${partName}" not found and creation not allowed` }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        existingSections = {};
        isNew = true;
        console.log(`[update-card-sections] Creating new card for "${partName}" in ${target.pathLabel}`);
      }

      // Merge: APPEND to existing sections, NEVER overwrite
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

      const fullCard = buildCard(target.registryEntry?.name || partName, existingSections);
      let resultFileName: string;

      if (card) {
        await updateFileById(token, card.fileId, fullCard, card.mimeType);
        resultFileName = card.fileName;
        console.log(`[update-card-sections] Updated ${card.fileName} in-place, sections: ${updatedKeys.join(",")}`);
      } else {
        const newFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
        await createFileInFolder(token, newFileName, fullCard, target.searchRootId);
        resultFileName = newFileName;
        console.log(`[update-card-sections] Created: ${newFileName} in ${target.pathLabel}`);
      }

      return new Response(JSON.stringify({
        success: true, cardFileName: resultFileName, sectionsUpdated: updatedKeys,
        isNewCard: isNew, path: target.pathLabel,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══════════════════════════════════════════════════════
    // MODE B: "update-dashboard" - 00_Aktualni_Dashboard
    // Location: 00_CENTRUM/
    // Method: Find existing → append daily summary at end
    // ═══════════════════════════════════════════════════════
    if (body.mode === "update-dashboard") {
      const { content } = body;
      if (!content) {
        return new Response(JSON.stringify({ error: "content required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const centerFolderId = registry?.centerFolderId;
      if (!centerFolderId) {
        return new Response(JSON.stringify({ error: "00_CENTRUM folder not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const doc = await findDocumentByPattern(token, centerFolderId, [
        "00_Aktualni_Dashboard", "Aktualni_Dashboard", "Dashboard",
      ]);
      if (!doc) {
        return new Response(JSON.stringify({ error: "Dashboard document not found in 00_CENTRUM" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const appendedContent = doc.content + `\n\n[${dateStr}]\n${content}`;
      await updateFileById(token, doc.fileId, appendedContent, doc.mimeType);
      console.log(`[update-dashboard] Appended to ${doc.fileName}`);

      return new Response(JSON.stringify({ success: true, fileName: doc.fileName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════
    // MODE C: "update-therapy-plan" - 05_Terapeuticky_Plan
    // Location: 00_CENTRUM/
    // Method: Find existing → append/update
    // ═══════════════════════════════════════════════════════
    if (body.mode === "update-therapy-plan") {
      const { content } = body;
      if (!content) {
        return new Response(JSON.stringify({ error: "content required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const centerFolderId = registry?.centerFolderId;
      if (!centerFolderId) {
        return new Response(JSON.stringify({ error: "00_CENTRUM folder not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const doc = await findDocumentByPattern(token, centerFolderId, [
        "05_Terapeuticky_Plan_Aktualni", "Terapeuticky_Plan", "05_Terapeuticky",
      ]);
      if (!doc) {
        return new Response(JSON.stringify({ error: "Therapy plan document not found in 00_CENTRUM" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const appendedContent = doc.content + `\n\n[${dateStr}]\n${content}`;
      await updateFileById(token, doc.fileId, appendedContent, doc.mimeType);
      console.log(`[update-therapy-plan] Appended to ${doc.fileName}`);

      return new Response(JSON.stringify({ success: true, fileName: doc.fileName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════
    // MODE D: "update-relations" - 04_Mapa_Vztahu
    // Location: 00_CENTRUM/
    // ═══════════════════════════════════════════════════════
    if (body.mode === "update-relations") {
      const { content } = body;
      if (!content) {
        return new Response(JSON.stringify({ error: "content required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const centerFolderId = registry?.centerFolderId;
      if (!centerFolderId) {
        return new Response(JSON.stringify({ error: "00_CENTRUM folder not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const doc = await findDocumentByPattern(token, centerFolderId, [
        "04_Mapa_Vztahu_a_Vazeb", "Mapa_Vztahu", "04_Mapa",
      ]);
      if (!doc) {
        return new Response(JSON.stringify({ error: "Relations map not found in 00_CENTRUM" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const appendedContent = doc.content + `\n\n[${dateStr}]\n${content}`;
      await updateFileById(token, doc.fileId, appendedContent, doc.mimeType);

      return new Response(JSON.stringify({ success: true, fileName: doc.fileName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════
    // MODE E: "update-line-card" - Linie overview card (L1-L6)
    // Location: 02_KLASTRY_A_RODOKMENY/
    // ═══════════════════════════════════════════════════════
    if (body.mode === "update-line-card") {
      const { lineName, content } = body;
      if (!lineName || !content) {
        return new Response(JSON.stringify({ error: "lineName and content required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const clusterFolderId = registry?.clusterFolderId;
      if (!clusterFolderId) {
        return new Response(JSON.stringify({ error: "02_KLASTRY_A_RODOKMENY folder not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const doc = await findDocumentByPattern(token, clusterFolderId, [
        `${lineName}_Linie_Prehled`, lineName,
      ]);
      if (!doc) {
        return new Response(JSON.stringify({ error: `Line card "${lineName}" not found in 02_KLASTRY` }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const appendedContent = doc.content + `\n\n[${dateStr}]\n${content}`;
      await updateFileById(token, doc.fileId, appendedContent, doc.mimeType);

      return new Response(JSON.stringify({ success: true, fileName: doc.fileName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════
    // MODE F: "create-agreement" - New therapeutic agreement
    // Location: 00_CENTRUM/06_Terapeuticke_Dohody/
    // This is the ONLY mode that creates a NEW file
    // ═══════════════════════════════════════════════════════
    if (body.mode === "create-agreement") {
      const { topic, content } = body;
      if (!topic || !content) {
        return new Response(JSON.stringify({ error: "topic and content required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const targetFolderId = registry?.agreementsFolderId;
      if (!targetFolderId) {
        return new Response(JSON.stringify({ error: "06_Terapeuticke_Dohody folder not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const fileName = `${dateStr}_${topic.replace(/\s+/g, "_")}.txt`;
      await createFileInFolder(token, fileName, content, targetFolderId);
      console.log(`[create-agreement] Created: ${fileName}`);

      return new Response(JSON.stringify({ success: true, fileName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ No valid mode ═══
    return new Response(JSON.stringify({
      error: "Invalid mode. Supported: update-card-sections, update-dashboard, update-therapy-plan, update-relations, update-line-card, create-agreement",
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
