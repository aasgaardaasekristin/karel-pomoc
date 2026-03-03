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
async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
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

async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  // Use Drive API multipart upload instead of Docs API (which may not be enabled)
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

// ═══ Section definitions ═══
const SECTION_DEFINITIONS: Record<string, string> = {
  A: "Kdo jsem", B: "Charakter a psychologický profil", C: "Potřeby, strachy, konflikty",
  D: "Terapeutická doporučení", E: "Chronologický log / Handover", F: "Poznámky pro Karla",
  G: "Deník sezení", H: "Dlouhodobé cíle", I: "Terapeutické metody a přístupy",
  J: "Krátkodobé cíle a aktuální intervence", K: "Výstupy ze sezení a zpětná vazba",
  L: "Aktivita a přítomnost části", M: "Karlova analytická poznámka",
};
const SECTION_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

function sectionHeader(letter: string): string { return `═══ SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]} ═══`; }

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

// ═══ Card finder ═══
async function findCardFile(token: string, partName: string, folderId: string): Promise<{ fileId: string; fileName: string; content: string; parentFolderId: string; mimeType?: string } | null> {
  const normalizedPart = canonicalText(partName);
  async function searchFolder(fid: string): Promise<any> {
    const files = await listFilesInFolder(token, fid);
    const matches: Array<{ file: typeof files[0]; priority: number }> = [];
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER_MIME) continue;
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      if (scoreNameMatch(normalizedPart, canonicalText(baseName)) > 0) {
        const isKartaTxt = /^karta_/i.test(f.name) && /\.txt$/i.test(f.name);
        matches.push({ file: f, priority: f.mimeType === DRIVE_DOC_MIME ? 0 : isKartaTxt ? 2 : 1 });
      }
    }
    matches.sort((a, b) => a.priority - b.priority);
    for (const { file: f } of matches) {
      try {
        const content = await readFileContent(token, f.id);
        return { fileId: f.id, fileName: f.name, content, parentFolderId: fid, mimeType: f.mimeType };
      } catch (e) { console.error(`[findCardFile] Cannot read ${f.name}:`, e); }
    }
    for (const sf of files.filter(f => f.mimeType === DRIVE_FOLDER_MIME)) {
      const result = await searchFolder(sf.id);
      if (result) return result;
    }
    return null;
  }
  return searchFolder(folderId);
}

async function findBestPartFolder(token: string, stateFolderId: string, entry: RegistryEntry): Promise<{ id: string; name: string } | null> {
  const files = await listFilesInFolder(token, stateFolderId);
  const folders = files.filter((f) => f.mimeType === DRIVE_FOLDER_MIME);
  const idPrefixRegex = entry.id ? new RegExp(`^0*${Number(entry.id)}(?:[_\\s-]|$)`) : null;
  const scored = folders.map((folder) => {
    let score = scoreNameMatch(entry.normalizedName, canonicalText(folder.name));
    if (idPrefixRegex && idPrefixRegex.test(folder.name)) score += 8;
    if (entry.id && canonicalText(folder.name).includes(entry.id)) score += 2;
    return { folder, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.folder || null;
}

// ═══ Perplexity research ═══
async function searchPerplexity(partName: string, cardContent: string): Promise<string> {
  const apiKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!apiKey) { console.warn("[perplexity] No API key"); return ""; }

  // Extract key themes from card content (first 1500 chars)
  const contentPreview = cardContent.slice(0, 1500);

  const query = `DID (Dissociative Identity Disorder) terapeutické metody a přístupy pro práci s částí/alterem jménem "${partName}". ` +
    `Na základě těchto informací o části: ${contentPreview.slice(0, 500)}. ` +
    `Najdi: 1) Konkrétní terapeutické techniky (IFS, EMDR, somatické metody, narativní terapie, hravé techniky) ` +
    `2) Vědecké studie a odborné zdroje (ISSTD guidelines, Journal of Trauma & Dissociation) ` +
    `3) Stabilizační a groundingové metody vhodné pro tento typ části ` +
    `4) Kreativní/hravé diagnostické a terapeutické aktivity ("skryté diagnostiky") ` +
    `Odpověz v češtině. Uveď konkrétní zdroje a reference.`;

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "Jsi odborný výzkumník specializovaný na DID (disociativní poruchu identity) a traumaterapii. Odpovídej výhradně na základě ověřených odborných zdrojů. NIKDY nevymýšlej citace, DOI ani statistiky." },
          { role: "user", content: query },
        ],
        search_mode: "academic",
      }),
    });
    if (!res.ok) { console.error(`[perplexity] ${res.status}`); return ""; }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const citations = (data.citations || []).map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
    return text + (citations ? `\n\n📚 Zdroje:\n${citations}` : "");
  } catch (e) {
    console.error("[perplexity] error:", e);
    return "";
  }
}

// ═══ AI reformatter ═══
async function reformatCardWithAI(partName: string, rawContent: string, perplexityResearch: string, entry: RegistryEntry, txtExtraContent: string = ""): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

  const systemPrompt = `Jsi Karel – DID system card editor. Tvůj úkol je vzít surový obsah karty části a přeformátovat ho do předepsané architektury sekcí A–M.

═══ ARCHITEKTURA KARTY ═══

SEKCE A – Kdo jsem
→ Senzorické kotvy a triggery, vztahy a vnitřní mediátoři, role/typ části, co část uklidňuje/potřebuje.

SEKCE B – Charakter a psychologický profil
→ Psychologické charakteristiky, behaviorální vzorce, ochranné mechanismy.

SEKCE C – Potřeby, strachy, konflikty
→ Rizika probuzení (trauma flooding, časová dezorientace), jádrové strachy, vnitřní konflikty s jinými částmi.

SEKCE D – Terapeutická doporučení
→ Tvrdá pravidla a kontraindikace (⚠️), terapeutické principy (ISSTD fáze, IFS, kooperace nad fúzí).

SEKCE E – Chronologický log / Handover
→ Časová osa událostí, datum vytvoření karty, kontaktní pokusy a výsledky. Formát: | Datum | Událost | Výsledek |

SEKCE F – Poznámky pro Karla
→ Situační karta ("Jsi v roce 2026, jsi v bezpečí..."), bezpečnostní pravidla, přímé instrukce.

SEKCE G – Deník sezení
→ Záznamy ze sezení. Formát: | Datum | Co se stalo | Stabilizace | Další krok |

SEKCE H – Dlouhodobé cíle
→ Integrační cíle, žádoucí budoucí role části v systému.

SEKCE I – Terapeutické metody a přístupy
→ VŠECHNY konkrétní techniky s PLNÝM popisem:
  NÁZEV | CÍL | POSTUP (krok za krokem) | PROČ FUNGUJE | PRO KOHO | ZDROJ | OBTÍŽNOST
  Minimum 3–5 metod na kartu. Včetně "skrytých diagnostik" (hry maskující techniku).

SEKCE J – Krátkodobé cíle a aktuální intervence
→ Akční plán 1–4 kroky, co připravit na příští sezení.

SEKCE K – Výstupy ze sezení a zpětná vazba
→ Formát: | Datum | Co bylo navrženo | Výsledek | Hodnocení |

SEKCE L – Aktivita a přítomnost části
→ Aktuální úroveň aktivity, délka neaktivity, pozorování.

SEKCE M – Karlova analytická poznámka
→ Syntéza a hypotézy, spojitosti s jinými částmi/klastry, doporučený směr.

═══ PRAVIDLA ═══
1. NERESUM – zachovej plný obsah každé metody a instrukce.
2. Každý údaj patří do JEDNÉ sekce – najdi nejlepší fit.
3. Pokud sekce nemá obsah, napiš "(zatím prázdné)".
4. Zachovej ⚠️ varování přesně tak, jak jsou.
5. Všechna data ve formátu YYYY-MM-DD.
6. Reference (ISSTD, EMDR, IFS) vždy zapiš do Sekce I vedle metody.
7. Pokud je k dispozici výzkum z Perplexity, integruj relevantní metody do Sekce I a doporučení do D/M.
8. NEKOPÍRUJ celé bloky textu doslovně – restrukturuj a roztřiď data.
9. Hlavička karty: ═══ KARTA ČÁSTI: [JMÉNO] ═══
10. Pokud jsou k dispozici data z .txt souborů, INTEGRUJ je do příslušných sekcí podle typu informace. Neukládej je do jedné sekce – roztřiď je logicky.

═══ METADATA Z REGISTRU ═══
ID: ${entry.id}
Jméno: ${entry.name}
Stav: ${entry.status}
Klastr: ${entry.cluster}
Poznámka: ${entry.note}`;

  const txtBlock = txtExtraContent
    ? `\n\n═══ DATA Z .TXT SOUBORŮ (roztřídit do příslušných sekcí) ═══\n${txtExtraContent.slice(0, 5000)}`
    : "";

  const userPrompt = `Přeformátuj tuto kartu části "${partName}" do architektury A–M.

═══ AKTUÁLNÍ OBSAH KARTY ═══
${rawContent.slice(0, 12000)}

${perplexityResearch ? `═══ VÝZKUM Z ODBORNÝCH ZDROJŮ (Perplexity) ═══\n${perplexityResearch.slice(0, 4000)}` : ""}
${txtBlock}

Výstup: Kompletní karta se VŠEMI sekcemi A–M ve formátu:
═══ KARTA ČÁSTI: ${partName} ═══

═══ SEKCE A – Kdo jsem ═══
[obsah]

═══ SEKCE B – Charakter a psychologický profil ═══
[obsah]
... atd. až po M.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error("AI rate limited – zkus to za chvíli");
    if (res.status === 402) throw new Error("AI credits – doplň kredity");
    throw new Error(`AI error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ═══ Recursive .txt file collector ═══
interface LooseTxtFile {
  fileId: string;
  fileName: string;
  content: string;
  parentFolderId: string;
  path: string; // human-readable path for logging
}

async function collectTxtFilesRecursive(token: string, folderId: string, currentPath: string): Promise<LooseTxtFile[]> {
  const files = await listFilesInFolder(token, folderId);
  const txtFiles: LooseTxtFile[] = [];

  for (const f of files) {
    if (f.mimeType === DRIVE_FOLDER_MIME) {
      // Recurse into subfolders
      const subResults = await collectTxtFilesRecursive(token, f.id, `${currentPath}/${f.name}`);
      txtFiles.push(...subResults);
    } else if (/\.txt$/i.test(f.name) && f.mimeType !== DRIVE_DOC_MIME && f.mimeType !== DRIVE_SHEET_MIME) {
      // It's a .txt file (not a Google Doc or Sheet)
      try {
        const content = await readFileContent(token, f.id);
        if (content && content.trim().length > 10) {
          txtFiles.push({ fileId: f.id, fileName: f.name, content, parentFolderId: folderId, path: `${currentPath}/${f.name}` });
        }
      } catch (e) {
        console.warn(`[txt-collect] Cannot read ${f.name}:`, e);
      }
    }
  }
  return txtFiles;
}

async function deleteDriveFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[txt-delete] Failed to delete ${fileId}: ${res.status}`);
  }
}

// ═══ AI: classify .txt content into parts ═══
interface TxtClassification {
  partName: string;
  relevantContent: string;
}

async function classifyTxtContents(token: string, txtFiles: LooseTxtFile[], registryEntries: RegistryEntry[]): Promise<Map<string, string>> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

  // Aggregate all txt contents with file names
  const txtSummary = txtFiles.map(f => `═══ SOUBOR: ${f.path} ═══\n${f.content.slice(0, 3000)}`).join("\n\n");
  const partNames = registryEntries.map(e => `${e.id} ${e.name}`).join(", ");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content: `Jsi třídič informací pro kartotéku DID systému. Dostaneš obsah .txt souborů a seznam částí (alter/fragmentů) z registru.

Tvůj úkol:
1. Analyzuj obsah každého .txt souboru
2. Rozeběr informace na jednotlivé bloky podle toho, ke které ČÁSTI systému logicky patří
3. Pokud informace patří k více částem, rozděl je a přiřaď ke každé zvlášť
4. Pokud informace nepatří ke konkrétní části ale k systému obecně, přiřaď je k části "SYSTEM_GENERAL"

VÝSTUP: Vrať JSON pole objektů:
[
  {"partName": "Jméno části přesně z registru", "relevantContent": "Extrahovaný text relevantní pro tuto část"},
  ...
]

Důležité:
- Jméno části MUSÍ odpovídat přesně jednomu z registru
- Nezkracuj obsah – zachovej plné informace
- Rozděl logicky – ne mechanicky po řádcích
- Pokud .txt soubor obsahuje informace o terapeutických metodách, rozděl je k částem, pro které jsou relevantní`
        },
        {
          role: "user",
          content: `═══ REGISTRY ČÁSTÍ ═══\n${partNames}\n\n═══ OBSAH .TXT SOUBORŮ ═══\n${txtSummary.slice(0, 20000)}`
        }
      ],
    }),
  });

  if (!res.ok) {
    console.error(`[txt-classify] AI error ${res.status}`);
    return new Map();
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";

  // Parse JSON from response (may be wrapped in markdown code block)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("[txt-classify] No JSON array found in AI response");
    return new Map();
  }

  try {
    const classifications: TxtClassification[] = JSON.parse(jsonMatch[0]);
    const partContentMap = new Map<string, string>();

    for (const c of classifications) {
      // Normalize part name to match registry
      const matchedEntry = registryEntries.find(e =>
        e.name === c.partName ||
        canonicalText(e.name) === canonicalText(c.partName)
      );
      const key = matchedEntry?.name || c.partName;
      const existing = partContentMap.get(key) || "";
      partContentMap.set(key, existing + (existing ? "\n\n" : "") + c.relevantContent);
    }

    return partContentMap;
  } catch (e) {
    console.error("[txt-classify] JSON parse error:", e);
    return new Map();
  }
}

// ═══ MAIN ═══
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const user = await requireAuth(req);
    const { dryRun } = await req.json().catch(() => ({ dryRun: false }));
    const token = await getAccessToken();

    // Find Kartoteka_DID root
    const rootFolderId = await findFolder(token, "Kartoteka_DID");
    if (!rootFolderId) throw new Error("Kartoteka_DID folder not found on Drive");

    // ═══ Phase 1: Collect loose .txt files ═══
    console.log("[reformat] Phase 1: Collecting .txt files...");
    const txtFiles = await collectTxtFilesRecursive(token, rootFolderId, "Kartoteka_DID");
    console.log(`[reformat] Found ${txtFiles.length} .txt files`);

    // Load registry
    const rootChildren = await listFilesInFolder(token, rootFolderId);
    const rootFolders = rootChildren.filter((f) => f.mimeType === DRIVE_FOLDER_MIME);

    const pickFolder = (pred: (c: string, r: string) => boolean) => rootFolders.find((f) => pred(canonicalText(f.name), f.name))?.id || null;
    const centerFolderId = pickFolder((c, r) => /^00/.test(r.trim()) || c.includes("centrum"));
    const activeFolderId = pickFolder((c, r) => /^01/.test(r.trim()) || c.includes("aktiv"));
    const archiveFolderId = pickFolder((c, r) => /^03/.test(r.trim()) || (c.includes("archiv") && /spic|spis/.test(c)));

    if (!centerFolderId) throw new Error("00_CENTRUM folder not found");

    // Find registry XLS
    const centerFiles = await listFilesInFolder(token, centerFolderId);
    const registryFile = centerFiles
      .filter((f) => f.mimeType === DRIVE_SHEET_MIME || XLS_MIME_TYPES.has(f.mimeType || "") || /\.xlsx?$/i.test(f.name))
      .map((file) => {
        const c = canonicalText(file.name);
        let score = 0;
        if (c.includes("01indexvsechcasti")) score += 10;
        else if (c.includes("indexvsechcasti")) score += 7;
        else if (c.includes("index") && c.includes("cast")) score += 4;
        return { file, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.file;

    if (!registryFile) throw new Error("Registry XLS not found in 00_CENTRUM");

    const rows = await readRegistryRows(token, registryFile);
    const entries = parseRegistryEntries(rows);
    console.log(`[reformat] Registry loaded: ${entries.length} entries from ${registryFile.name}`);

    if (entries.length === 0) throw new Error("Registry is empty");

    // ═══ Phase 2: Classify .txt content into parts ═══
    let txtContentByPart = new Map<string, string>();
    if (txtFiles.length > 0 && !dryRun) {
      console.log("[reformat] Phase 2: Classifying .txt content into parts...");
      txtContentByPart = await classifyTxtContents(token, txtFiles, entries);
      console.log(`[reformat] Classified content for ${txtContentByPart.size} parts`);
    }

    // ═══ Phase 3: Process each entry (reformat + merge .txt content) ═══
    const results: Array<{ name: string; id: string; status: string; result: "reformatted" | "not_found" | "error" | "dry_run"; detail: string }> = [];
    const txtFilesProcessed: string[] = [];

    for (const entry of entries) {
      console.log(`[reformat] Processing: ${entry.id} ${entry.name} (${entry.status})`);

      try {
        // Determine folder
        const isArchived = isArchivedFromRegistry(entry);
        const stateFolderId = isArchived ? archiveFolderId : activeFolderId;
        if (!stateFolderId) {
          results.push({ name: entry.name, id: entry.id, status: entry.status, result: "error", detail: `Složka ${isArchived ? "archiv" : "aktivní"} nenalezena` });
          continue;
        }

        // Find part subfolder
        const partFolder = await findBestPartFolder(token, stateFolderId, entry);
        const searchFolderId = partFolder?.id || stateFolderId;

        // Find card file
        const card = await findCardFile(token, entry.name, searchFolderId);
        if (!card) {
          results.push({ name: entry.name, id: entry.id, status: entry.status, result: "not_found", detail: `Karta nenalezena v ${isArchived ? "03_ARCHIV" : "01_AKTIVNI"}/${partFolder?.name || "root"}` });
          continue;
        }

        console.log(`[reformat] Card found: ${card.fileName} (${card.fileId})`);

        if (dryRun) {
          const hasTxtData = txtContentByPart.has(entry.name);
          results.push({ name: entry.name, id: entry.id, status: entry.status, result: "dry_run", detail: `Nalezena: ${card.fileName}${hasTxtData ? " + data z .txt souborů" : ""}` });
          continue;
        }

        // Search Perplexity for enrichment
        let perplexityContent = "";
        try {
          perplexityContent = await searchPerplexity(entry.name, card.content);
          if (perplexityContent) console.log(`[reformat] Perplexity research for ${entry.name}: ${perplexityContent.length} chars`);
        } catch (e) {
          console.warn(`[reformat] Perplexity failed for ${entry.name}:`, e);
        }

        // Get any .txt content classified for this part
        const txtExtraContent = txtContentByPart.get(entry.name) || "";
        if (txtExtraContent) {
          console.log(`[reformat] Adding ${txtExtraContent.length} chars from .txt files for ${entry.name}`);
        }

        // AI reformat — now includes .txt content
        const reformattedContent = await reformatCardWithAI(entry.name, card.content, perplexityContent, entry, txtExtraContent);

        if (!reformattedContent || reformattedContent.length < 100) {
          results.push({ name: entry.name, id: entry.id, status: entry.status, result: "error", detail: "AI vrátilo příliš krátký výstup" });
          continue;
        }

        // Write back
        await updateFileById(token, card.fileId, reformattedContent, card.mimeType);
        results.push({ name: entry.name, id: entry.id, status: entry.status, result: "reformatted", detail: `${card.fileName} přeformátováno (${reformattedContent.length} znaků)${txtExtraContent ? " + .txt data" : ""}` });
        console.log(`[reformat] ✅ ${entry.name} done`);

        // Small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 2000));

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[reformat] ❌ ${entry.name}:`, msg);
        results.push({ name: entry.name, id: entry.id, status: entry.status, result: "error", detail: msg });

        // If rate limited, wait longer
        if (msg.includes("rate limit")) await new Promise((r) => setTimeout(r, 10000));
      }
    }

    // ═══ Phase 4: Delete processed .txt files ═══
    if (txtFiles.length > 0 && !dryRun) {
      console.log(`[reformat] Phase 4: Deleting ${txtFiles.length} .txt files...`);
      for (const txtFile of txtFiles) {
        try {
          await deleteDriveFile(token, txtFile.fileId);
          txtFilesProcessed.push(txtFile.path);
          console.log(`[reformat] 🗑️ Deleted: ${txtFile.path}`);
        } catch (e) {
          console.warn(`[reformat] Failed to delete ${txtFile.path}:`, e);
        }
      }
    }

    // Summary
    const reformatted = results.filter((r) => r.result === "reformatted");
    const notFound = results.filter((r) => r.result === "not_found");
    const errors = results.filter((r) => r.result === "error");

    // Send summary email
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const kataEmail = Deno.env.get("KATA_EMAIL");
    if (resendKey && kataEmail && !dryRun) {
      const resend = new Resend(resendKey);
      const txtSection = txtFilesProcessed.length > 0
        ? `<h3>🗑️ Zpracované a smazané .txt soubory (${txtFilesProcessed.length})</h3><ul>${txtFilesProcessed.map(p => `<li>${p}</li>`).join("")}</ul>`
        : txtFiles.length > 0 ? `<p>📄 Nalezeno ${txtFiles.length} .txt souborů, obsah roztříděn do ${txtContentByPart.size} karet</p>` : "";

      const emailBody = `
<h2>📋 Přeformátování kartotéky DID – Souhrn</h2>
<p><strong>Celkem částí v registru:</strong> ${entries.length}</p>
<p><strong>Přeformátováno:</strong> ${reformatted.length}</p>
<p><strong>Nenalezeno:</strong> ${notFound.length}</p>
<p><strong>Chyby:</strong> ${errors.length}</p>
<p><strong>.txt souborů zpracováno:</strong> ${txtFilesProcessed.length}/${txtFiles.length}</p>

<h3>✅ Přeformátováno</h3>
<ul>${reformatted.map((r) => `<li>${r.id} ${r.name} – ${r.detail}</li>`).join("")}</ul>

${txtSection}
${notFound.length > 0 ? `<h3>⚠️ Karty nenalezeny</h3><ul>${notFound.map((r) => `<li>${r.id} ${r.name} (${r.status}) – ${r.detail}</li>`).join("")}</ul>` : ""}
${errors.length > 0 ? `<h3>❌ Chyby</h3><ul>${errors.map((r) => `<li>${r.id} ${r.name} – ${r.detail}</li>`).join("")}</ul>` : ""}
`;
      try {
        await resend.emails.send({
          from: "Karel <karel@lovable.app>",
          to: [kataEmail],
          subject: `📋 Přeformátování kartotéky: ${reformatted.length}/${entries.length} karet | ${txtFilesProcessed.length} .txt zpracováno`,
          html: emailBody,
        });
      } catch (e) { console.warn("[reformat] Email failed:", e); }
    }

    return new Response(JSON.stringify({
      success: true,
      dryRun: !!dryRun,
      total: entries.length,
      reformatted: reformatted.length,
      notFound: notFound.length,
      errors: errors.length,
      txtFilesFound: txtFiles.length,
      txtFilesDeleted: txtFilesProcessed.length,
      txtDistributedToParts: Array.from(txtContentByPart.keys()),
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("[reformat] Fatal:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
