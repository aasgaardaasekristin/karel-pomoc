import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import * as XLSX from "npm:xlsx@0.18.5";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// ═══ OAuth2 token helper ═══
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

// ═══ Drive helpers ═══
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLS_MIME_TYPES = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);

const stripDiacritics = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const canonicalText = (v: string) => stripDiacritics(v || "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

function scoreNameMatch(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 10;
  if (left.includes(right) || right.includes(left)) return 7;
  if (left.slice(0, 6) === right.slice(0, 6)) return 3;
  return 0;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
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

async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const boundary = "----DIDDocUpdateBoundary";
  const metadata = JSON.stringify({ mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH (doc) failed (${res.status}): ${await res.text()}`);
}

async function updateFileById(token: string, fileId: string, content: string, mimeType?: string): Promise<any> {
  if (mimeType === DRIVE_DOC_MIME) { await updateGoogleDocInPlace(token, fileId, content); return { id: fileId }; }
  const boundary = "----DIDReformatBoundary";
  const metadata = JSON.stringify({});
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed: ${await res.text()}`);
  return await res.json();
}

async function deleteDriveFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) console.warn(`[delete] Failed ${fileId}: ${res.status}`);
}

// ═══ Registry ═══
interface RegistryEntry { id: string; name: string; status: string; cluster: string; note: string; normalizedName: string; }

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
  const findCol = (hints: string[], fallback: number) => { const idx = header.findIndex((h) => hints.some((hint) => h.includes(hint))); return idx >= 0 ? idx : fallback; };
  const idCol = findCol(["id", "cislo", "number"], 0);
  const nameCol = findCol(["jmeno", "nazev", "cast", "part", "fragment"], 1);
  const statusCol = findCol(["stav", "status"], 2);
  const clusterCol = findCol(["klastr", "cluster"], 3);
  const noteCol = findCol(["poznam", "note", "komentar"], 4);
  const entries: RegistryEntry[] = [];
  for (const row of nonEmptyRows.slice(headerRowIndex + 1)) {
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

async function readRegistryRows(token: string, file: { id: string; name: string; mimeType?: string }): Promise<string[][]> {
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
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  return (XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { header: 1, raw: false, defval: "" }) as any[][]).map((row) => row.map((cell) => `${cell ?? ""}`.trim()));
}

function isArchivedFromRegistry(entry: RegistryEntry): boolean {
  const statusCanonical = canonicalText(entry.status || "");
  const archivedStatus = /^(spi|spic|spis|sleep|dormant|archiv|neaktiv|usp|hibern)/;
  const activeStatus = /^(aktiv|active|probuzen|awake|online)/;
  if (archivedStatus.test(statusCanonical)) return true;
  if (activeStatus.test(statusCanonical)) return false;
  const combined = canonicalText(`${entry.status} ${entry.cluster} ${entry.note}`);
  if (/(spic|spis|spi|sleep|dormant|archiv|neaktiv|uspany|uspavana)/.test(combined)) return true;
  return false;
}

const REQUIRED_SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
type CardLocation = "active" | "archive";
interface CardFileRef { fileId: string; fileName: string; content: string; mimeType?: string; }

function extractSections(content: string) {
  const found = REQUIRED_SECTIONS.filter((s) => new RegExp(`SEKCE\\s+${s}(?:\\b|\\s*[–-])`, "i").test(content));
  const missing = REQUIRED_SECTIONS.filter((s) => !found.includes(s));
  return { found, missing, complete: missing.length === 0 };
}

async function findCardWithFallback(
  token: string,
  entry: RegistryEntry,
  activeFolderId: string | null,
  archiveFolderId: string | null,
): Promise<{ card: CardFileRef | null; expectedLocation: CardLocation; locatedIn: CardLocation | null }> {
  const expectedLocation: CardLocation = isArchivedFromRegistry(entry) ? "archive" : "active";
  const candidates: Array<{ location: CardLocation; folderId: string | null }> = expectedLocation === "active"
    ? [{ location: "active", folderId: activeFolderId }, { location: "archive", folderId: archiveFolderId }]
    : [{ location: "archive", folderId: archiveFolderId }, { location: "active", folderId: activeFolderId }];

  for (const candidate of candidates) {
    if (!candidate.folderId) continue;
    const card = await findCardFile(token, entry.name, candidate.folderId, entry);
    if (card) {
      return { card, expectedLocation, locatedIn: candidate.location };
    }
  }

  return { card: null, expectedLocation, locatedIn: null };
}

// ═══ Card finder — searches directly in state folder (flat structure) ═══
async function findCardFile(token: string, partName: string, stateFolderId: string, entry: RegistryEntry): Promise<{ fileId: string; fileName: string; content: string; mimeType?: string } | null> {
  const normalizedPart = canonicalText(partName);
  const files = await listFilesInFolder(token, stateFolderId);
  
  const matches: Array<{ file: typeof files[0]; priority: number; score: number }> = [];
  
  for (const f of files) {
    if (f.mimeType === DRIVE_FOLDER_MIME) continue;
    const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
    const canonBase = canonicalText(baseName);
    const nameScore = scoreNameMatch(normalizedPart, canonBase);
    
    // Also check if the file name contains the entry ID prefix
    const idPrefixRegex = entry.id ? new RegExp(`^0*${Number(entry.id)}(?:[_\\s-]|$)`) : null;
    const hasIdPrefix = idPrefixRegex && idPrefixRegex.test(f.name);
    
    if (nameScore > 0 || hasIdPrefix) {
      // Prefer Google Docs over .txt files
      const isDoc = f.mimeType === DRIVE_DOC_MIME;
      const isTxtFile = /\.txt$/i.test(f.name) && f.mimeType !== DRIVE_DOC_MIME;
      const priority = isDoc ? 0 : isTxtFile ? 2 : 1;
      matches.push({ file: f, priority, score: nameScore + (hasIdPrefix ? 8 : 0) });
    }
  }
  
  // Sort: highest score first, then by priority (docs first)
  matches.sort((a, b) => b.score - a.score || a.priority - b.priority);
  
  for (const { file: f } of matches) {
    try {
      const content = await readFileContent(token, f.id);
      return { fileId: f.id, fileName: f.name, content, mimeType: f.mimeType };
    } catch (e) {
      console.error(`[findCard] Cannot read ${f.name}:`, e);
    }
  }
  
  return null;
}

// ═══ Perplexity research ═══
async function searchPerplexity(partName: string, cardContent: string): Promise<string> {
  const apiKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!apiKey) return "";
  const contentPreview = cardContent.slice(0, 1500);
  const query = `DID (Dissociative Identity Disorder) terapeutické metody a přístupy pro práci s částí/alterem jménem "${partName}". Na základě: ${contentPreview.slice(0, 500)}. Najdi: 1) Konkrétní terapeutické techniky (IFS, EMDR, somatické, narativní, hravé) 2) Vědecké zdroje (ISSTD, Journal of Trauma & Dissociation) 3) Stabilizační a groundingové metody 4) Kreativní diagnostické aktivity. Odpověz v češtině.`;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "Jsi odborný výzkumník na DID a traumaterapii. NIKDY nevymýšlej citace." },
          { role: "user", content: query },
        ],
        search_mode: "academic",
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const citations = (data.citations || []).map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
    return text + (citations ? `\n\n📚 Zdroje:\n${citations}` : "");
  } catch { return ""; }
}

// ═══ AI reformatter ═══
async function reformatCardWithAI(partName: string, rawContent: string, perplexityResearch: string, entry: RegistryEntry, txtExtraContent: string = ""): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

  const systemPrompt = `Jsi Karel – DID system card editor. Tvůj úkol je vzít surový obsah karty části a přeformátovat ho do předepsané architektury sekcí A–M.

═══ ARCHITEKTURA KARTY ═══

SEKCE A – Kdo jsem: Senzorické kotvy, triggery, vztahy, role/typ části, co uklidňuje.
SEKCE B – Charakter a psychologický profil: Psychologické charakteristiky, vzorce, ochranné mechanismy.
SEKCE C – Potřeby, strachy, konflikty: Rizika probuzení, jádrové strachy, vnitřní konflikty.
SEKCE D – Terapeutická doporučení: Kontraindikace (⚠️), principy (ISSTD, IFS).
SEKCE E – Chronologický log / Handover: Časová osa. Formát: | Datum | Událost | Výsledek |
SEKCE F – Poznámky pro Karla: Situační karta, bezpečnostní pravidla.
SEKCE G – Deník sezení: Záznamy. Formát: | Datum | Co se stalo | Stabilizace | Další krok |
SEKCE H – Dlouhodobé cíle: Integrační cíle, budoucí role.
SEKCE I – Terapeutické metody: VŠECHNY techniky s PLNÝM popisem: NÁZEV | CÍL | POSTUP | PROČ FUNGUJE | PRO KOHO | ZDROJ | OBTÍŽNOST. Min 3–5 metod. Včetně "skrytých diagnostik".
SEKCE J – Krátkodobé cíle: Akční plán 1–4 kroky.
SEKCE K – Výstupy ze sezení: Formát: | Datum | Navrženo | Výsledek | Hodnocení |
SEKCE L – Aktivita a přítomnost: Aktuální úroveň, délka neaktivity.
SEKCE M – Karlova analytická poznámka: Syntéza, hypotézy, doporučený směr.

═══ PRAVIDLA ═══
1. NERESUM – zachovej plný obsah.
2. Každý údaj do JEDNÉ sekce.
3. Prázdné sekce: "(zatím prázdné)".
4. Zachovej ⚠️ varování.
5. Data ve formátu YYYY-MM-DD.
6. Integruj Perplexity výzkum do I a D/M.
7. NEKOPÍRUJ bloky doslovně – restrukturuj.
8. Hlavička: KARTA ČÁSTI: [JMÉNO] (BEZ ═══ znaků – ty se špatně zobrazují v Google Docs)
9. .txt data INTEGRUJ do příslušných sekcí.
10. Formát sekcí: SEKCE X – [název] (BEZ ═══ znaků)

═══ METADATA Z REGISTRU ═══
ID: ${entry.id} | Jméno: ${entry.name} | Stav: ${entry.status} | Klastr: ${entry.cluster} | Poznámka: ${entry.note}`;

  const txtBlock = txtExtraContent ? `\n\n═══ DATA Z .TXT SOUBORŮ ═══\n${txtExtraContent.slice(0, 5000)}` : "";

  const userPrompt = `Přeformátuj kartu "${partName}" do A–M architektury.

═══ AKTUÁLNÍ OBSAH ═══
${rawContent.slice(0, 12000)}

${perplexityResearch ? `═══ VÝZKUM (Perplexity) ═══\n${perplexityResearch.slice(0, 4000)}` : ""}
${txtBlock}

Výstup: Kompletní karta se VŠEMI sekcemi A–M.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error("RATE_LIMITED");
    throw new Error(`AI error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ═══ Recursive .txt file collector ═══
interface LooseTxtFile { fileId: string; fileName: string; content: string; path: string; }

async function collectTxtFilesRecursive(token: string, folderId: string, currentPath: string): Promise<LooseTxtFile[]> {
  const files = await listFilesInFolder(token, folderId);
  const txtFiles: LooseTxtFile[] = [];
  for (const f of files) {
    if (f.mimeType === DRIVE_FOLDER_MIME) {
      txtFiles.push(...await collectTxtFilesRecursive(token, f.id, `${currentPath}/${f.name}`));
    } else if (/\.txt$/i.test(f.name) && f.mimeType !== DRIVE_DOC_MIME && f.mimeType !== DRIVE_SHEET_MIME) {
      try {
        const content = await readFileContent(token, f.id);
        if (content && content.trim().length > 10) {
          txtFiles.push({ fileId: f.id, fileName: f.name, content, path: `${currentPath}/${f.name}` });
        }
      } catch (e) { console.warn(`[txt] Cannot read ${f.name}:`, e); }
    }
  }
  return txtFiles;
}

// ═══ MODES ═══
// mode=list → returns registry entries + txt files (no processing)
// mode=process_one → processes a single card by index
// mode=cleanup_txt → classifies & deletes txt files (called once at end)

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const user = await requireAuth(req);
    const body = await req.json().catch(() => ({ mode: "list", index: 0 }));
    const { mode, index, txtContentForPart } = body;
    const token = await getAccessToken();

    // Find root
    const findFolderQ = `name='Kartoteka_DID' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
    const findParams = new URLSearchParams({ q: findFolderQ, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const rootRes = await fetch(`https://www.googleapis.com/drive/v3/files?${findParams}`, { headers: { Authorization: `Bearer ${token}` } });
    const rootFolderId = (await rootRes.json()).files?.[0]?.id;
    if (!rootFolderId) throw new Error("Kartoteka_DID not found");

    const rootChildren = await listFilesInFolder(token, rootFolderId);
    const rootFolders = rootChildren.filter(f => f.mimeType === DRIVE_FOLDER_MIME);
    const pickFolder = (pred: (c: string, r: string) => boolean) => rootFolders.find(f => pred(canonicalText(f.name), f.name.trim()))?.id || null;
    const centerFolderId = pickFolder((c, r) => /^00/.test(r) || c.includes("centrum"));
    const activeFolderId = pickFolder((c, r) => /^01/.test(r) || c.includes("aktiv"));
    const archiveFolderId = pickFolder((c, r) => /^03/.test(r) || (c.includes("archiv") && /spic|spis/.test(c)));

    if (!centerFolderId) throw new Error("00_CENTRUM not found");

    // Load registry
    const centerFiles = await listFilesInFolder(token, centerFolderId);
    const registryFile = centerFiles
      .filter(f => f.mimeType === DRIVE_SHEET_MIME || XLS_MIME_TYPES.has(f.mimeType || "") || /\.xlsx?$/i.test(f.name))
      .map(file => {
        const c = canonicalText(file.name);
        let score = 0;
        if (c.includes("01indexvsechcasti")) score += 10;
        else if (c.includes("indexvsechcasti")) score += 7;
        else if (c.includes("index") && c.includes("cast")) score += 4;
        return { file, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.file;
    if (!registryFile) throw new Error("Registry XLS not found");

    const rows = await readRegistryRows(token, registryFile);
    const entries = parseRegistryEntries(rows);

    // ═══ MODE: LIST ═══
    if (mode === "list") {
      // Also collect txt files
      const txtFiles = await collectTxtFilesRecursive(token, rootFolderId, "Kartoteka_DID");
      
      // Classify txt content if any
      let txtContentByPart: Record<string, string> = {};
      if (txtFiles.length > 0) {
        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
        if (LOVABLE_API_KEY) {
          const txtSummary = txtFiles.map(f => `═══ ${f.path} ═══\n${f.content.slice(0, 3000)}`).join("\n\n");
          const partNames = entries.map(e => `${e.id} ${e.name}`).join(", ");
          try {
            const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash",
                messages: [
                  { role: "system", content: `Roztřiď informace z .txt souborů k příslušným částem DID systému. Vrať JSON: [{"partName":"přesné jméno z registru","relevantContent":"text"}]. Jméno MUSÍ odpovídat registru.` },
                  { role: "user", content: `REGISTRY: ${partNames}\n\nTXT:\n${txtSummary.slice(0, 20000)}` },
                ],
              }),
            });
            if (aiRes.ok) {
              const raw = (await aiRes.json()).choices?.[0]?.message?.content || "";
              const jsonMatch = raw.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                const classifications: Array<{ partName: string; relevantContent: string }> = JSON.parse(jsonMatch[0]);
                for (const c of classifications) {
                  const matched = entries.find(e => e.name === c.partName || canonicalText(e.name) === canonicalText(c.partName));
                  const key = matched?.name || c.partName;
                  txtContentByPart[key] = (txtContentByPart[key] || "") + "\n\n" + c.relevantContent;
                }
              }
            }
          } catch (e) { console.warn("[list] txt classify failed:", e); }
        }
      }

      return new Response(JSON.stringify({
        mode: "list",
        entries: entries.map((e, i) => ({ index: i, id: e.id, name: e.name, status: e.status, cluster: e.cluster })),
        total: entries.length,
        txtFiles: txtFiles.map(f => ({ fileId: f.fileId, path: f.path })),
        txtContentByPart,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ MODE: AUDIT (batch) ═══
    // Accepts optional "start" and "count" params (default: start=0, count=5)
    if (mode === "audit") {
      const start = typeof index === "number" ? index : 0;
      const count = body.count || 5;
      const end = Math.min(start + count, entries.length);

      const items: Array<{
        index: number;
        id: string;
        name: string;
        expectedFolder: CardLocation;
        locatedIn: CardLocation | null;
        fileName: string | null;
        found: boolean;
        sectionsFound: string[];
        sectionsMissing: string[];
        complete: boolean;
      }> = [];

      for (let i = start; i < end; i++) {
        const entry = entries[i];
        const located = await findCardWithFallback(token, entry, activeFolderId, archiveFolderId);

        if (!located.card) {
          items.push({
            index: i, id: entry.id, name: entry.name,
            expectedFolder: located.expectedLocation, locatedIn: null,
            fileName: null, found: false, sectionsFound: [], sectionsMissing: [...REQUIRED_SECTIONS], complete: false,
          });
          continue;
        }

        const sections = extractSections(located.card.content);
        items.push({
          index: i, id: entry.id, name: entry.name,
          expectedFolder: located.expectedLocation, locatedIn: located.locatedIn,
          fileName: located.card.fileName, found: true,
          sectionsFound: sections.found, sectionsMissing: sections.missing, complete: sections.complete,
        });
      }

      return new Response(JSON.stringify({
        mode: "audit",
        totalRegistry: entries.length,
        rangeStart: start,
        rangeEnd: end,
        items,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ MODE: PROCESS_ONE ═══
    if (mode === "process_one") {
      const entry = entries[index];
      if (!entry) throw new Error(`Invalid index ${index}`);

      const located = await findCardWithFallback(token, entry, activeFolderId, archiveFolderId);
      if (!located.card) {
        return new Response(JSON.stringify({
          mode: "process_one", index, name: entry.name, result: "not_found",
          detail: "Karta nenalezena ani v 01_AKTIVNI ani v 03_ARCHIV",
          expectedFolder: located.expectedLocation,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const card = located.card;
      console.log(`[reformat] Processing ${entry.id} ${entry.name} (${card.fileName})`);

      // Perplexity research
      let perplexityContent = "";
      try { perplexityContent = await searchPerplexity(entry.name, card.content); } catch {}

      // AI reformat
      const txtExtra = txtContentForPart || "";
      const reformattedContent = await reformatCardWithAI(entry.name, card.content, perplexityContent, entry, txtExtra);

      if (!reformattedContent || reformattedContent.length < 100) {
        return new Response(JSON.stringify({
          mode: "process_one", index, name: entry.name, result: "error",
          detail: "AI vrátilo příliš krátký výstup",
          expectedFolder: located.expectedLocation,
          locatedIn: located.locatedIn,
          fileName: card.fileName,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Write back
      await updateFileById(token, card.fileId, reformattedContent, card.mimeType);
      console.log(`[reformat] ✅ ${entry.name} done (${reformattedContent.length} chars)`);

      return new Response(JSON.stringify({
        mode: "process_one", index, name: entry.name, result: "reformatted",
        detail: `${card.fileName} přeformátováno (${reformattedContent.length} znaků)${txtExtra ? " + .txt data" : ""}`,
        expectedFolder: located.expectedLocation,
        locatedIn: located.locatedIn,
        fileName: card.fileName,
        contentLength: reformattedContent.length,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ MODE: CLEANUP_TXT ═══
    if (mode === "cleanup_txt") {
      const txtFiles = await collectTxtFilesRecursive(token, rootFolderId, "Kartoteka_DID");
      const deleted: string[] = [];
      for (const f of txtFiles) {
        try {
          await deleteDriveFile(token, f.fileId);
          deleted.push(f.path);
          console.log(`[cleanup] 🗑️ ${f.path}`);
        } catch (e) { console.warn(`[cleanup] Failed ${f.path}:`, e); }
      }

      // Send summary email
      const resendKey = Deno.env.get("RESEND_API_KEY");
      const kataEmail = Deno.env.get("KATA_EMAIL");
      if (resendKey && kataEmail) {
        try {
          const resend = new Resend(resendKey);
          await resend.emails.send({
            from: "Karel <karel@lovable.app>",
            to: [kataEmail],
            subject: `🗑️ Vyčištěno ${deleted.length} .txt souborů z kartotéky`,
            html: `<h2>Smazané .txt soubory</h2><ul>${deleted.map(p => `<li>${p}</li>`).join("")}</ul>`,
          });
        } catch {}
      }

      return new Response(JSON.stringify({
        mode: "cleanup_txt", found: txtFiles.length, deleted: deleted.length, deletedFiles: deleted,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ MODE: CONVERT_TO_DOC ═══
    // Converts .txt card files to Google Docs AND strips ═══ lines from all cards
    // Processes in batches (default 3 at a time) to avoid timeouts
    if (mode === "convert_to_doc") {
      const start = typeof index === "number" ? index : 0;
      const count = body.count || 3;
      const end = Math.min(start + count, entries.length);

      const results: Array<{
        index: number;
        name: string;
        action: "converted" | "cleaned" | "not_found" | "error";
        oldFileName?: string;
        newFileName?: string;
        detail?: string;
      }> = [];

      for (let i = start; i < end; i++) {
        const entry = entries[i];
        const located = await findCardWithFallback(token, entry, activeFolderId, archiveFolderId);

        if (!located.card) {
          results.push({ index: i, name: entry.name, action: "not_found", detail: "Karta nenalezena" });
          continue;
        }

        const card = located.card;
        try {
          // Clean content: strip ═══ characters from section headers and title
          let cleanedContent = card.content;
          // Clean section headers: ═══ SEKCE X – Name ═══ → SEKCE X – Name
          cleanedContent = cleanedContent.replace(/═+\s*(SEKCE\s+[A-M]\s*[–\-:][^\n]*?)═*/g, "$1").replace(/\s+$/gm, "");
          // Clean card title: ═══ KARTA ČÁSTI: NAME ═══ → KARTA ČÁSTI: NAME
          cleanedContent = cleanedContent.replace(/═+\s*(KARTA\s+[ČC]ÁSTI:[^\n]*?)═*/gi, "$1").replace(/\s+$/gm, "");
          // Remove remaining ═══ and ─── decorative lines (standalone lines of only these chars)
          cleanedContent = cleanedContent.replace(/^[═─]{3,}\s*$/gm, "");
          // Remove excessive blank lines (more than 2 consecutive)
          cleanedContent = cleanedContent.replace(/\n{4,}/g, "\n\n\n");

          const isTxtFile = card.mimeType !== DRIVE_DOC_MIME;

          if (isTxtFile) {
            // CREATE new Google Doc + delete old .txt
            const newName = card.fileName.replace(/\.txt$/i, "");
            const parentFolderId = located.locatedIn === "archive" ? archiveFolderId : activeFolderId;
            if (!parentFolderId) throw new Error("Parent folder not found");

            // Create Google Doc
            const boundary = "----ConvertBoundary";
            const metadata = JSON.stringify({ name: newName, parents: [parentFolderId], mimeType: DRIVE_DOC_MIME });
            const uploadBody = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${cleanedContent}\r\n--${boundary}--`;
            const createRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
              body: uploadBody,
            });
            if (!createRes.ok) throw new Error(`Create failed: ${await createRes.text()}`);
            const newDoc = await createRes.json();

            // Apply formatting via Docs API
            await applyDocFormatting(token, newDoc.id, cleanedContent);

            // Delete old .txt
            await deleteDriveFile(token, card.fileId);

            console.log(`[convert] ✅ ${entry.name}: ${card.fileName} (.txt) → ${newName} (Google Doc)`);
            results.push({ index: i, name: entry.name, action: "converted", oldFileName: card.fileName, newFileName: newName });
          } else {
            // Already a Google Doc – just clean content and reformat
            await updateGoogleDocInPlace(token, card.fileId, cleanedContent);
            // Apply formatting
            await applyDocFormatting(token, card.fileId, cleanedContent);

            console.log(`[convert] ✅ ${entry.name}: ${card.fileName} cleaned (removed ═══)`);
            results.push({ index: i, name: entry.name, action: "cleaned", oldFileName: card.fileName });
          }
        } catch (e) {
          console.error(`[convert] ❌ ${entry.name}:`, e);
          results.push({ index: i, name: entry.name, action: "error", detail: e instanceof Error ? e.message : String(e) });
        }
      }

      return new Response(JSON.stringify({
        mode: "convert_to_doc",
        totalRegistry: entries.length,
        rangeStart: start,
        rangeEnd: end,
        hasMore: end < entries.length,
        nextIndex: end < entries.length ? end : null,
        results,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown mode. Use: list, audit, process_one, cleanup_txt, convert_to_doc" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[reformat] Fatal:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
