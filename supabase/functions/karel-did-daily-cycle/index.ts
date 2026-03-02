import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
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

async function updateFileById(token: string, fileId: string, content: string, mimeType?: string): Promise<any> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";

  if (isGoogleDoc) {
    // Google Docs cannot be updated via Drive upload API.
    // Strategy: delete old Google Doc and create a new plain text file in same folder.
    // This is a one-time migration per card.
    console.log(`[updateFileById] Google Doc detected (${fileId}), will create .txt replacement`);
    throw new Error("GOOGLE_DOC_CANNOT_UPDATE");
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
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
  return await res.json();
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
  return `═══ SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]} ═══`;
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
  lines.push(sections["_preamble"] || `═══ KARTA ČÁSTI: ${partName} ═══`);
  lines.push("");
  for (const letter of SECTION_ORDER) {
    lines.push(sectionHeader(letter));
    lines.push(sections[letter] || "(zatím prázdné)");
    lines.push("");
  }
  return lines.join("\n");
}

interface CardFileResult { fileId: string; fileName: string; content: string; parentFolderId: string; mimeType?: string; }

type DriveFile = { id: string; name: string; mimeType?: string };

async function findCardFile(token: string, partName: string, rootFolderId: string): Promise<CardFileResult | null> {
  const normalizedPart = partName.toLowerCase().replace(/\s+/g, "").replace(/[_-]/g, "");

  async function searchFolder(folderId: string): Promise<CardFileResult | null> {
    const files = await listFilesInFolder(token, folderId);
    
    // Collect all matching files, prefer .txt over Google Docs
    const matches: Array<{ file: typeof files[0]; priority: number }> = [];
    for (const f of files) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      const baseName = f.name.replace(/\.(txt|md|doc|docx)$/i, "");
      const normalizedFileName = baseName.toLowerCase().replace(/[_\s-]/g, "");
      if (normalizedFileName.includes(normalizedPart)) {
        // .txt files get priority 0 (best), Google Docs get priority 2 (fallback)
        const priority = /\.txt$/i.test(f.name) ? 0 : f.mimeType === "application/vnd.google-apps.document" ? 2 : 1;
        matches.push({ file: f, priority });
      }
    }
    
    // Sort by priority (prefer .txt)
    matches.sort((a, b) => a.priority - b.priority);
    
    for (const { file: f } of matches) {
      try {
        const content = await readFileContent(token, f.id);
        console.log(`[findCardFile] Found "${partName}": ${f.name} (${f.id}) mimeType=${f.mimeType} in folder ${folderId}`);
        return { fileId: f.id, fileName: f.name, content, parentFolderId: folderId, mimeType: f.mimeType };
      } catch (e) { console.error(`[findCardFile] Cannot read ${f.name}:`, e); }
    }
    const subfolders = files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
    for (const sf of subfolders) {
      const result = await searchFolder(sf.id);
      if (result) return result;
    }
    return null;
  }

  return searchFolder(rootFolderId);
}

// Update card sections in-place by file ID
async function updateCardSections(token: string, partName: string, newSections: Record<string, string>, folderId: string): Promise<{ fileName: string; sectionsUpdated: string[]; isNew: boolean }> {
  const card = await findCardFile(token, partName, folderId);
  const dateStr = new Date().toISOString().slice(0, 10);
  let existingSections: Record<string, string>;
  let isNew = false;

  if (card) {
    existingSections = parseCardSections(card.content);
    console.log(`[updateCardSections] Card: ${card.fileName}, existing sections: ${Object.keys(existingSections).filter(k => k !== "_preamble").join(",")}`);
  } else {
    existingSections = {};
    isNew = true;
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

  const fullCard = buildCard(partName, existingSections);

  if (card) {
    try {
      await updateFileById(token, card.fileId, fullCard, card.mimeType);
      return { fileName: card.fileName, sectionsUpdated: updatedKeys, isNew: false };
    } catch (e) {
      if (e instanceof Error && e.message === "GOOGLE_DOC_CANNOT_UPDATE") {
        // Google Doc → create a .txt companion in the same folder
        const txtName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
        console.log(`[updateCardSections] Google Doc "${card.fileName}" cannot be updated via API. Creating .txt companion: ${txtName}`);
        await createFileInFolder(token, txtName, fullCard, card.parentFolderId);
        return { fileName: txtName, sectionsUpdated: updatedKeys, isNew: true };
      }
      throw e;
    }
  } else {
    const newFileName = `Karta_${partName.replace(/\s+/g, "_")}.txt`;
    await createFileInFolder(token, newFileName, fullCard, folderId);
    return { fileName: newFileName, sectionsUpdated: updatedKeys, isNew: true };
  }
}

function isTextCandidateFile(file: DriveFile): boolean {
  if (file.mimeType === "application/vnd.google-apps.folder") return false;
  // Google Docs cannot be updated via multipart upload API – skip them
  if (file.mimeType === "application/vnd.google-apps.document") return false;

  const lower = file.name.toLowerCase();
  if (lower.startsWith("did_")) return false;
  if (lower.startsWith("00_") || lower.startsWith("01_") || lower.startsWith("02_")) return false;
  if (lower.includes("denni_report") || lower.includes("tydenni_report")) return false;
  if (lower.includes("instrukce") || lower.includes("mapa_vztahu")) return false;

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

async function normalizeCardStructures(token: string, rootFolderId: string): Promise<string[]> {
  const files = await listFilesRecursive(token, rootFolderId);
  const candidateFiles = files.filter(isTextCandidateFile);
  const normalized: string[] = [];

  for (const file of candidateFiles) {
    try {
      const original = await readFileContent(token, file.id);
      if (!looksLikeDidCard(file.name, original)) continue;

      const rebuilt = buildCard(partNameFromFileName(file.name), parseCardSections(original));
      if (rebuilt.trim() !== original.trim()) {
        await updateFileById(token, file.id, rebuilt, file.mimeType);
        normalized.push(file.name);
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

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. SBĚR DAT – ALL unprocessed threads + conversations (no time cutoff!)
    const { data: threadRows } = await sb.from("did_threads").select("*").eq("is_processed", false);
    const threads = threadRows ?? [];

    const { data: convRows } = await sb.from("did_conversations").select("*").eq("is_processed", false);
    const conversations = convRows ?? [];

    const { data: cycle } = await sb.from("did_update_cycles").insert({ cycle_type: "daily", status: "running" }).select().single();

    // 2. NORMALIZACE STRUKTURY KARET A-M (probíhá vždy)
    const token = await getAccessToken();
    const folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
    const normalizedCardFiles = folderId ? await normalizeCardStructures(token, folderId) : [];
    const cardsUpdated: string[] = normalizedCardFiles.map(name => `${name} (normalizace A-M)`);

    if (threads.length === 0 && conversations.length === 0) {
      if (cycle) {
        await sb.from("did_update_cycles").update({
          status: "completed",
          completed_at: new Date().toISOString(),
          report_summary: normalizedCardFiles.length > 0
            ? `Normalizováno ${normalizedCardFiles.length} karet na strukturu A–M.`
            : "No threads to process",
          cards_updated: cardsUpdated,
        }).eq("id", cycle.id);
      }

      return new Response(JSON.stringify({
        success: true,
        message: normalizedCardFiles.length > 0
          ? "No threads to process; card structure normalized"
          : "No threads to process",
        threadsProcessed: 0,
        conversationsProcessed: 0,
        cardsUpdated,
        normalizedCards: normalizedCardFiles.length,
        reportSent: false,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. COMPILE THREAD + CONVERSATION DATA
    const threadSummaries = threads.map(t => {
      const msgs = (t.messages as any[]) || [];
      return `=== Vlákno: ${t.part_name} (${t.sub_mode}) ===\nJazyk: ${t.part_language}\nZačátek: ${t.started_at}\nPoslední aktivita: ${t.last_activity_at}\nPočet zpráv: ${msgs.length}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? "ČÁST/UŽIVATEL" : "KAREL"}]: ${typeof m.content === "string" ? m.content : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    const convSummaries = conversations.map(c => {
      const msgs = (c.messages as any[]) || [];
      return `=== Konverzace: ${c.sub_mode} (${c.label}) ===\nUloženo: ${c.saved_at}\n\nKonverzace:\n${msgs.map((m: any) => `[${m.role === "user" ? "UŽIVATEL" : "KAREL"}]: ${typeof m.content === "string" ? m.content : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    const allSummaries = [threadSummaries, convSummaries].filter(Boolean).join("\n\n=== KONVERZACE Z JINÝCH PODREŽIMŮ ===\n\n");

    let driveContext = "";
    let existingCards: Record<string, string> = {};

    if (folderId) {
      try {
        const partsFileId = await findFile(token, "00_Seznam_casti.txt", folderId);
        if (partsFileId) driveContext = await readFileContent(token, partsFileId);
      } catch (e) { console.error("Drive read error:", e); }

      // Collect ALL unique part names from threads AND conversations
      const threadParts = threads.map(t => t.part_name);
      const convParts: string[] = [];
      for (const c of conversations) {
        const msgs = (c.messages as any[]) || [];
        // Extract part names mentioned in conversation context
        for (const m of msgs) {
          if (typeof m.content === "string") {
            // Check for part names in known parts context
            const content = m.content;
            if (content.length > 10) {
              // The AI will identify parts from the conversation content
              break;
            }
          }
        }
      }

      const activeParts = [...new Set([...threadParts, ...convParts])];
      for (const partName of activeParts) {
        try {
          const card = await findCardFile(token, partName, folderId);
          if (card) existingCards[partName] = card.content;
        } catch {}
      }
    }

    // 3. AI ANALÝZA – full A-M decomposition
    const existingCardsContext = Object.entries(existingCards).map(([name, content]) =>
      `=== EXISTUJÍCÍ KARTA: ${name} ===\n${content}`
    ).join("\n\n");

    const analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – analytik DID systému. Zpracuj data z rozhovorů a rozlož KAŽDOU informaci do správných sekcí karet částí.

═══ ZÁKLADNÍ PRAVIDLO ═══
Jeden dokument/konverzace = mnoho informací = každá informace má svou sekci.
NIKDY nevkládej celou konverzaci do jedné sekce. NIKDY nemažeš původní obsah – pouze doplňuješ nebo upřesňuješ.

═══ POSTUP ═══
1. Identifikuj o které části každá konverzace pojednává
2. Projdi konverzaci odstavec po odstavci
3. Pro každou informaci urči kam patří podle mapy níže
4. Pokud karta části neexistuje → vytvoř novou se VŠEMI sekcemi A–M

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

SEKCE F – Poznámky pro Karla:
- Situační karta ("Jsi v roce 2026, jsi v bezpečí...")
- Bezpečnostní pokyny pro Karla
- Co Karel musí vědět před příštím kontaktem

SEKCE G – Deník sezení:
- Záznamy: | Datum | Co se dělo | Stabilizace | Další krok |

SEKCE H – Dlouhodobé cíle:
- Směr vývoje části (integrace, stabilizace, budování důvěry)
- Karlovy hypotézy o budoucím směru

SEKCE I – Terapeutické metody a přístupy:
- VŠECHNY konkrétní techniky a metody CELÉ (ne zkrácené!)
- Název metody, postup krok za krokem, proč to funguje
- Zdroj/odkaz, obtížnost

SEKCE J – Krátkodobé cíle a aktuální intervence:
- Akční plán (číslované kroky)
- Co připravit před příštím setkáním

SEKCE K – Výstupy ze sezení a zpětná vazba:
- Co se osvědčilo/neosvědčilo: | Datum | Co bylo navrženo | Výsledek | Hodnocení |

SEKCE L – Aktivita a přítomnost části:
- | Období | Aktivita | Poznámka |

SEKCE M – Karlova analytická poznámka:
- Karlova syntéza a dedukce z konverzace
- Spojitosti s jinými částmi/klastry
- Hypotézy a doporučený směr

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
- Co bylo změněno (karta + sekce) a proč
- Shrnutí: kdo dnes mluvil a jaké části byly aktivní
- Doporučení pro mamku (co dělat večer + proč)
- Doporučení pro Káťu (jak reagovat + proč)
[/REPORT]

═══ PRAVIDLA ═══
- NIKDY nesmaž původní data – pouze doplňuj s datem [YYYY-MM-DD]
- Metody v sekci I piš CELÉ (postup, proč funguje, zdroj)
- Přizpůsob jazyk části (norsky pro norské, česky pro ostatní)
- Pokud detekuješ novou část bez karty, navrhni obsah pro VŠECHNY sekce A–M
- Každá sekce musí obsahovat POUZE informace relevantní pro danou sekci

${driveContext ? `\nSOUČASNÝ SEZNAM ČÁSTÍ:\n${driveContext}` : ""}
${existingCardsContext ? `\nEXISTUJÍCÍ KARTY:\n${existingCardsContext}` : ""}`,
          },
          { role: "user", content: allSummaries },
        ],
      }),
    });

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
    }

    // 4. PARSE AND UPDATE CARDS IN-PLACE

    if (folderId && analysisText) {
      const cardBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      for (const match of analysisText.matchAll(cardBlockRegex)) {
        const partName = match[1].trim();
        const cardBlock = match[2];

        const sectionRegex = /\[SEKCE:([A-M])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
        const newSections: Record<string, string> = {};
        for (const sm of cardBlock.matchAll(sectionRegex)) {
          const letter = sm[1].toUpperCase();
          const content = sm[2].trim();
          if (content) newSections[letter] = content;
        }

        if (Object.keys(newSections).length > 0) {
          try {
            const result = await updateCardSections(token, partName, newSections, folderId);
            cardsUpdated.push(`${partName} (${result.sectionsUpdated.join(",")}${result.isNew ? " – NOVÁ" : ""})`);
            console.log(`Updated card: ${result.fileName}, sections: ${result.sectionsUpdated.join(",")}`);
          } catch (e) {
            console.error(`Failed to update card for ${partName}:`, e);
          }
        }
      }

      // Daily report (separate file – this IS correct as a standalone report)
      const reportMatch = analysisText.match(/\[REPORT\]([\s\S]*?)\[\/REPORT\]/);
      const reportText = reportMatch?.[1]?.trim() || analysisText;
      const dateStr = new Date().toISOString().slice(0, 10);
      await uploadOrUpdate(token, `DID_Denni_Report_${dateStr}.txt`, reportText, folderId);

      // 5. EMAIL
      if (RESEND_API_KEY && reportText) {
        try {
          const resend = new Resend(RESEND_API_KEY);
          const dateCz = new Date().toLocaleDateString("cs-CZ");

          let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${reportText}</pre>`;
          try {
            const fmtRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  { role: "system", content: "Přeformátuj do čistého HTML emailu. Zachovej obsah, přidej h2, p, ul, li, strong. Přidej seznam aktualizovaných karet: " + cardsUpdated.join(", ") + ". Vrať POUZE HTML." },
                  { role: "user", content: reportText },
                ],
              }),
            });
            if (fmtRes.ok) {
              const fmtData = await fmtRes.json();
              const formatted = fmtData.choices?.[0]?.message?.content;
              if (formatted) htmlContent = formatted.replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
            }
          } catch {}

          await resend.emails.send({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: [MAMKA_EMAIL, KATA_EMAIL],
            subject: `Karel – Denní report DID ${dateCz}`,
            html: htmlContent,
          });
          console.log(`Daily report sent to ${MAMKA_EMAIL} and ${KATA_EMAIL} in one email`);
        } catch (e) { console.error("Email send error:", e); }
      }
    }

    // 6. Mark threads AND conversations as processed
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
        status: "completed", completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000), cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
    }

    return new Response(JSON.stringify({ success: true, threadsProcessed: threads.length, conversationsProcessed: conversations.length, cardsUpdated, reportSent: !!RESEND_API_KEY }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Daily cycle error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
