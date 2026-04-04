import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import * as XLSX from "npm:xlsx@0.18.5";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

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

// ── Content hash (FNV-1a 32bit) for dedup markers [KHASH:xxxxxxxx] ──
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hasKhash(existingContent: string, hash: string): boolean {
  return existingContent.includes(`[KHASH:${hash}]`);
}

// ═══ EVIDENCE VALIDATOR: Validate [SRC:] tags in CENTRUM blocks ═══
function validateCentrumEvidence(
  centrumContent: string,
  validSources: Set<string>, // e.g. "cast|Arthur", "mamka|Hanka", "kata|Kata"
  docName: string,
): { validated: string; rejectedCount: number; keptCount: number } {
  // Parse paragraphs/lines and check each for [SRC:...] tags
  const lines = centrumContent.split("\n");
  const validatedLines: string[] = [];
  let rejectedCount = 0;
  let keptCount = 0;

  // Lines that are structural (headers, empty, bullets without claims) pass through
  const isStructuralLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^(SEKCE\s+\d|OPERATIVNÍ|AKTUÁLNÍ|Dashboard|═|─|▸\s*$|🎯|⚠️|💤|💬|🔍|📋|✅\s*Žádná)/i.test(trimmed)) return true;
    if (/^(Aktualizace:|Správce:|Správce:)/i.test(trimmed)) return true;
    // Short lines (labels, headers) pass
    if (trimmed.length < 30 && !trimmed.includes(":")) return true;
    return false;
  };

  // Check if a line contains a clinical claim that NEEDS evidence
  const isClinicalClaim = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 20) return false;
    // Skip structural/formatting lines
    if (isStructuralLine(line)) return false;
    // Lines with data references (dates, numbers, simple lists) can pass
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
    // Lines that are just status indicators
    if (/^[▸\-*•]\s*(Žádné|Žádná|Viz |N\/A|–$)/i.test(trimmed)) return false;
    // DEDUCTIVE CONTENT EXEMPTIONS: Karlovy dedukce, trendy, predikce, registry-based data
    // These are synthesized by Karel from DB data and don't need [SRC:] tags
    if (/(?:Karlova dedukce|DEDUKCE|TREND\s*[↑↗→↘↓]|stabilita\s*\(\d|PREDIKCE|predikce|PŘÍČINA|příčinný|AKCE:|DOKDY:|CO:|PROČ:)/i.test(trimmed)) return false;
    // Registry-based status lines (parts with emojis, IDs, sleep status)
    if (/^▸\s*.+\[(?:💤|🟢|🟡|🔴|ID:)/i.test(trimmed)) return false;
    // Watchlist/sleeping parts descriptions from registry
    if (/(?:spí|💤|Neaktivní|bez aktivity|Riziko spontánního probuzení)/i.test(trimmed) && /(?:▸|^\-)/i.test(trimmed)) return false;
    // Souhrn/summary lines (aggregated data)
    if (/^(?:Souhrn:|Celkov)/i.test(trimmed)) return false;
    // Clinical content: contains specific claims about parts, states, recommendations
    return /(?:komunikoval|mluvil|cítí|potřebuje|doporučen|riziko|trigger|aktivní|probuz|regres|pokrok|metoda|technika|sezení)/i.test(trimmed);
  };

  for (const line of lines) {
    if (isStructuralLine(line) || !isClinicalClaim(line)) {
      validatedLines.push(line);
      continue;
    }

    // This line contains a clinical claim – check for [SRC:] tag
    const srcMatch = line.match(/\[SRC:([^\]]+)\]/);
    if (!srcMatch) {
      // No evidence tag – reject this line
      console.warn(`[EVIDENCE-VALIDATOR] ⛔ Rejected (no [SRC:] tag) in ${docName}: "${line.trim().slice(0, 80)}..."`);
      rejectedCount++;
      continue;
    }

    // Validate the source reference
    const srcRef = srcMatch[1].trim(); // e.g. "cast|Arthur|msg3"
    const srcParts = srcRef.split("|");
    const srcKey = srcParts.slice(0, 2).join("|").toLowerCase(); // "cast|arthur"

    // Check if this source exists in our data
    let sourceValid = false;
    for (const vs of validSources) {
      if (vs.toLowerCase() === srcKey || vs.toLowerCase().includes(srcParts[0]?.toLowerCase())) {
        sourceValid = true;
        break;
      }
    }

    if (sourceValid) {
      // Strip the [SRC:] tag from output (it was for validation only)
      validatedLines.push(line.replace(/\s*\[SRC:[^\]]+\]\s*/g, " ").trim());
      keptCount++;
    } else {
      console.warn(`[EVIDENCE-VALIDATOR] ⛔ Rejected (invalid source "${srcRef}") in ${docName}: "${line.trim().slice(0, 80)}..."`);
      rejectedCount++;
    }
  }

  console.log(`[EVIDENCE-VALIDATOR] ${docName}: kept=${keptCount}, rejected=${rejectedCount}, structural=${lines.length - keptCount - rejectedCount}`);
  return { validated: validatedLines.join("\n"), rejectedCount, keptCount };
}

// ═══ SEMANTIC DEDUP CHECK: AI-powered similarity gate ═══
async function semanticDedupCheck(
  newContent: string,
  existingContent: string,
  sectionLabel: string,
  partName: string,
): Promise<{ isDuplicate: boolean; reason: string }> {
  if (!existingContent || existingContent.length < 20 || existingContent === "(zatím prázdné)") {
    return { isDuplicate: false, reason: "empty_section" };
  }

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return { isDuplicate: false, reason: "no_api_key" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        tools: [{
          type: "function",
          function: {
            name: "dedup_result",
            description: "Return whether new content is semantically duplicate of existing content",
            parameters: {
              type: "object",
              properties: {
                isDuplicate: { type: "boolean", description: "true if the core meaning is already present in existing content" },
                reason: { type: "string", description: "Brief explanation (max 50 chars)" },
              },
              required: ["isDuplicate", "reason"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "dedup_result" } },
        messages: [
          {
            role: "system",
            content: SYSTEM_RULES + `\n\nPorovnej NOSNOU MYŠLENKU nového záznamu s existujícím obsahem sekce. Odpověz isDuplicate=true POUZE pokud je JÁDRO VÝZNAMU (ne formulace) již přítomno. Různá slova pro stejný fakt = DUPLICITA. Nový detail k existujícímu faktu = NENÍ DUPLICITA.`,
          },
          {
            role: "user",
            content: `SEKCE ${sectionLabel} karty "${partName}":\n\nEXISTUJÍCÍ OBSAH:\n${existingContent.slice(0, 1500)}\n\nNOVÝ ZÁZNAM:\n${newContent.slice(0, 500)}`,
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[SEMANTIC-DEDUP] AI call failed (${res.status}), falling back to KHASH-only`);
      return { isDuplicate: false, reason: "api_error" };
    }

    const data = await res.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[SEMANTIC-DEDUP] Section ${sectionLabel} for "${partName}": isDuplicate=${args.isDuplicate}, reason="${args.reason}"`);
      return { isDuplicate: !!args.isDuplicate, reason: args.reason || "" };
    }

    return { isDuplicate: false, reason: "no_tool_response" };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      console.warn(`[SEMANTIC-DEDUP] Timeout (5s) for section ${sectionLabel} of "${partName}", falling back to KHASH-only`);
    } else {
      console.warn(`[SEMANTIC-DEDUP] Error for section ${sectionLabel} of "${partName}":`, e);
    }
    return { isDuplicate: false, reason: "timeout_or_error" };
  }
}

// ═══ POST-WRITE VERIFICATION: Read back and verify CENTRUM doc ═══
async function verifyCentrumWrite(
  token: string,
  fileId: string,
  docName: string,
  requiredKeywords: string[],
): Promise<{ verified: boolean; length: number; missingKeywords: string[] }> {
  try {
    const content = await readFileContent(token, fileId);
    const missing = requiredKeywords.filter(kw => !content.toLowerCase().includes(kw.toLowerCase()));
    const verified = content.length > 200 && missing.length === 0;
    if (!verified) {
      console.warn(`[VERIFY-CENTRUM] ⚠️ ${docName}: length=${content.length}, missing=[${missing.join(",")}]`);
    } else {
      console.log(`[VERIFY-CENTRUM] ✅ ${docName}: length=${content.length}, all ${requiredKeywords.length} keywords present`);
    }
    return { verified, length: content.length, missingKeywords: missing };
  } catch (e) {
    console.error(`[VERIFY-CENTRUM] Failed to read back ${docName}:`, e);
    return { verified: false, length: 0, missingKeywords: requiredKeywords };
  }
}

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

  // Hard guard: bez zápisu mimo oficiální registr
  if (!entry) {
    return {
      searchRootId: registryContext.activeFolderId || rootFolderId,
      allowCreate: false,
      pathLabel: "blokováno: mimo oficiální registr",
      registryEntry: null,
      actionType: "aktualizace",
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
  options?: { allowCreate?: boolean; searchName?: string; canonicalPartName?: string; registryContext?: RegistryContext | null; sectionModes?: Record<string, string> }
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

  // Accept optional sectionModes parameter for REPLACE/ROTATE support
  const sectionModes: Record<string, string> = (options as any)?.sectionModes || {};
  
  const updatedKeys: string[] = [];
  let dedupSkips = 0;
  let semanticDedupSkips = 0;
  for (const [letter, newContent] of Object.entries(newSections)) {
    const ul = letter.toUpperCase();
    if (!SECTION_ORDER.includes(ul)) continue;
    const existing = existingSections[ul] || "";
    const mode = sectionModes[ul] || "APPEND";
    
    // REPLACE mode: AI generated the complete section, replace entirely
    if (mode === "REPLACE" || mode === "ROTATE") {
      const hash = contentHash(newContent.trim());
      // Even for REPLACE, check if content is identical to avoid unnecessary writes
      if (existing && hasKhash(existing, hash)) {
        console.log(`[KHASH-dedup] Skipping section ${ul} for "${partName}" (REPLACE mode) – hash ${hash} already present`);
        dedupSkips++;
        continue;
      }
      existingSections[ul] = `[${dateStr}] ${newContent} [KHASH:${hash}]`;
      updatedKeys.push(ul);
      console.log(`[updateCardSections] ${mode} section ${ul} for "${partName}" (${newContent.length} chars)`);
      continue;
    }
    
    // APPEND mode (default): standard behavior
    const hash = contentHash(newContent.trim());
    if (existing && hasKhash(existing, hash)) {
      console.log(`[KHASH-dedup] Skipping section ${ul} for "${partName}" – hash ${hash} already present`);
      dedupSkips++;
      continue;
    }

    // SEMANTIC DEDUP: AI-powered similarity gate (after KHASH, before write)
    if (existing && existing !== "(zatím prázdné)" && existing.length > 30) {
      const dedupResult = await semanticDedupCheck(newContent, existing, ul, partName);
      if (dedupResult.isDuplicate) {
        console.log(`[SEMANTIC-DEDUP] ⛔ Blocked section ${ul} for "${partName}": "${dedupResult.reason}"`);
        semanticDedupSkips++;
        continue;
      }
    }
    
    const timestamped = `[${dateStr}] ${newContent} [KHASH:${hash}]`;
    if (existing && existing !== "(zatím prázdné)") {
      existingSections[ul] = existing + "\n\n" + timestamped;
    } else {
      existingSections[ul] = timestamped;
    }
    updatedKeys.push(ul);
  }
  
  if (dedupSkips > 0) {
    console.log(`[KHASH-dedup] ${dedupSkips} section(s) skipped for "${partName}" (duplicate content)`);
  }
  if (semanticDedupSkips > 0) {
    console.log(`[SEMANTIC-DEDUP] ${semanticDedupSkips} section(s) blocked for "${partName}" (semantically duplicate)`);
  }
  
  if (updatedKeys.length === 0 && card) {
    // All sections were duplicates – no write needed
    console.log(`[KHASH-dedup] All sections for "${partName}" already present, skipping Drive write`);
    return { fileName: card.fileName, sectionsUpdated: [], isNew: false };
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

function getUserMessages(messages: any[]): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m: any) => m?.role === "user" && typeof m?.content === "string")
    .map((m: any) => (m.content as string).trim())
    .filter(Boolean);
}

function clipText(value: string, max = 220): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function detectExplicitSelfIdentification(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  // "arthur"
  const singleWord = normalized.match(/^[a-zA-Zá-žÁ-Ž][a-zA-Zá-žÁ-Ž'\-]{1,24}$/u);
  if (singleWord) return singleWord[0];

  // "jsem arthur" / "já jsem arthur" / "i am arthur" / "my name is arthur"
  const explicit = normalized.match(/^(?:jsem|já\s+jsem|tady|i\s+am|i'm|my\s+name\s+is)\s+([a-zA-Zá-žÁ-Ž][a-zA-Zá-žÁ-Ž'\-]{1,24})$/iu);
  if (explicit) return explicit[1];

  return null;
}

function extractUnknownStructuredPartMentions(content: string, allowedCanonicalNames: Set<string>): string[] {
  if (allowedCanonicalNames.size === 0) return [];

  const candidates = new Set<string>();
  const re = /(?:^|\n)\s*[▸\-*•]?\s*([a-zA-Zá-žÁ-Ž][a-zA-Zá-žÁ-Ž'\-]{1,30})\s*(?:\/\s*ID|\[ID:|-\s*Stav:)/giu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    const canonical = canonicalText(name);
    if (!canonical || allowedCanonicalNames.has(canonical)) continue;
    candidates.add(name);
  }

  return [...candidates];
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

// ═══ KROK 0B – AUDIT STRUKTURY KARTY PŘED ZPRACOVÁNÍM ═══
// Povinný krok při každém spuštění aktualizace kartotéky.
// Ověří strukturu A-M, doplní chybějící sekce, opraví malformátování,
// povýší STUB karty na PLNÉ pokud existují data z vlákna.

const SECTION_TEMPLATES: Record<string, string> = {
  A: "(zatím prázdné)\n\nZákladní identita:\n* ID:\n* Jméno:\n* Věk:\n* Pohlaví:\n* Jazyk:\n* Typ:\n* Klastr:\n* Status:\n\nHistorický kontext:\n\nCo uklidňuje:\n\nSenzorické kotvy:\n\nVztahy:\n\nTechnology povědomí o systému:",
  B: "(zatím prázdné)\n\nAktuální stav (posuvné okno):\n-\n-\n-\n\nPsychologické charakteristiky:\n\nPsychologická profilace / Osobnostní profil:\n\nObranné mechanismy:\n\nReakce na kontakt:",
  C: "(zatím prázdné)\n\nJádrové potřeby:\n-\n\nJádrové strachy:\n-\n\nTriggery:\n-\n\nVnitřní konflikty:\n-\n\nIdentifikovaná rizika:\n-",
  D: "(zatím prázdné)\n\nPrincipy práce:\n-\n\nKontraindikace:\n-\n\nDoporučené terapeutické techniky:\n-",
  E: "(zatím prázdné)\n\nAktuální stav:\n\nChronologický log:\nDatum\tUdálost\tVýsledek",
  F: "(zatím prázdné)\n\nSituační karta:\n\nBezpečnostní pravidla:\n\nPoznámky pro příští kontakt:",
  G: "(zatím prázdné)\n\nDatum\tCo se dělo\tStabilizační opatření\tDalší krok",
  H: "(zatím prázdné)\n\nDlouhodobé cíle:\n-\n\nTalent & Growth Profile:",
  I: "(zatím prázdné)\n\nTerapeutické metody a přístupy:\nNázev | Cíl | Postup | Pomůcky | Proč to funguje | Terapeut | Časový horizont",
  J: "(zatím prázdné)\n\nAktuální stav – tři priority:\n1.\n2.\n3.\n\nNávrh intervence pro nejbližší dny:\n-\n\nKrizové situace:\n-",
  K: "(zatím prázdné)\n\nDatum | Co bylo navrženo | Výsledek | Hodnocení",
  L: "(zatím prázdné)\n\nObdobí | Aktivita | Poznámka",
  M: "(zatím prázdné)\n\nKarlova analytická poznámka:",
};

interface AuditResult {
  partName: string;
  fileName: string;
  changes: string[];
  promoted: boolean; // STUB → FULL
  created: boolean;  // brand new card
  alertForHanka: string | null; // ⚠️ alert for daily report
}

// ═══ CASE 2 HELPERS: Validate subsection structure against reference ═══
const SECTION_EXPECTED_SUBSECTIONS: Record<string, string[]> = {
  A: ["Základní identita", "Historický kontext", "Co uklidňuje", "Senzorické kotvy", "Vztahy", "Povědomí o systému"],
  B: ["Aktuální stav", "Psychologické charakteristiky", "Psychologická profilace", "Osobnostní profil", "Obranné mechanismy", "Reakce na kontakt"],
  C: ["Jádrové potřeby", "Jádrové strachy", "Triggery", "Vnitřní konflikty", "Identifikovaná rizika"],
  D: ["Principy práce", "Kontraindikace", "Doporučené terapeutické techniky"],
  E: ["Aktuální stav", "Chronologický log"],
  F: ["Situační karta", "Bezpečnostní pravidla", "Poznámky pro příští kontakt"],
  J: ["Aktuální stav", "tři priority", "Návrh intervence", "Krizové situace"],
};

function detectStructuralIssues(letter: string, sectionContent: string): { hasIssues: boolean; unclassifiable: string[] } {
  const expected = SECTION_EXPECTED_SUBSECTIONS[letter];
  if (!expected || !sectionContent || sectionContent === "(zatím prázdné)") {
    return { hasIssues: false, unclassifiable: [] };
  }

  const contentLower = stripDiacritics(sectionContent).toLowerCase();
  const unclassifiable: string[] = [];

  // Check for non-standard blocks: lines starting with headers that don't match expected subsections
  const headerLines = sectionContent.split("\n").filter(line => {
    const trimmed = line.trim();
    // Lines that look like subsection headers (bold-ish, ending with colon, or all-caps)
    return trimmed.length > 3 && trimmed.length < 80 &&
      (trimmed.endsWith(":") || /^[A-ZÁ-Ž][A-ZÁ-Ž\s]{3,}$/.test(trimmed) || /^[*•▸►]/.test(trimmed) === false) &&
      !/^\d{4}-\d{2}-\d{2}/.test(trimmed) && // not dates
      !/^[-–—]/.test(trimmed) && // not bullets
      !/^\(/.test(trimmed); // not parenthetical notes
  });

  for (const headerLine of headerLines) {
    const headerNorm = stripDiacritics(headerLine.trim().replace(/:$/, "")).toLowerCase();
    const matchesExpected = expected.some(exp =>
      stripDiacritics(exp).toLowerCase().split(/\s+/).some(word =>
        word.length > 3 && headerNorm.includes(word)
      )
    );
    if (!matchesExpected && headerLine.trim().length > 5) {
      // This header doesn't match any expected subsection
      unclassifiable.push(headerLine.trim());
    }
  }

  return { hasIssues: unclassifiable.length > 0, unclassifiable };
}

async function auditCardStructure(
  token: string,
  fileId: string,
  fileName: string,
  fileMimeType: string | undefined,
  partName: string,
  hasThreadData: boolean,
): Promise<AuditResult> {
  const changes: string[] = [];
  let promoted = false;
  const dateStr = new Date().toISOString().slice(0, 10);

  let content: string;
  try {
    content = await readFileContent(token, fileId);
  } catch (e) {
    console.error(`[AUDIT-0B] Cannot read card "${fileName}":`, e);
    return { partName, fileName, changes: [`ERR: nelze číst kartu`], promoted: false, created: false, alertForHanka: null };
  }

  if (!looksLikeDidCard(fileName, content)) {
    return { partName, fileName, changes: [], promoted: false, created: false, alertForHanka: null };
  }

  const sections = parseCardSections(content);
  const existingLetters = Object.keys(sections).filter(k => k !== "_preamble" && SECTION_ORDER.includes(k));

  // Detect STUB card: has only A and/or E
  const isStub = existingLetters.length <= 2 && existingLetters.every(l => l === "A" || l === "E");

  // Case 3: STUB without thread data → leave as is (intentional state)
  if (isStub && !hasThreadData) {
    console.log(`[AUDIT-0B] "${partName}": STUB karta bez dat z vlákna – ponecháno beze změny`);
    return { partName, fileName, changes: [], promoted: false, created: false, alertForHanka: null };
  }

  let needsWrite = false;

  // Case 1 & 2: Check every section A-M
  for (const letter of SECTION_ORDER) {
    const existing = sections[letter];

    if (!existing || existing.trim() === "") {
      // ═══ Case 1: Missing section entirely → create with template ═══
      sections[letter] = SECTION_TEMPLATES[letter] || "(zatím prázdné)";
      changes.push(`chyběla sekce ${letter} – automaticky vytvořena`);
      needsWrite = true;
    } else {
      const trimmed = existing.trim();

      // ═══ Case 1b: Section exists but is effectively empty ═══
      if (trimmed.length < 3 && trimmed !== "-") {
        sections[letter] = SECTION_TEMPLATES[letter] || "(zatím prázdné)";
        changes.push(`sekce ${letter} měla nesprávnou strukturu – automaticky opravena`);
        needsWrite = true;
        continue;
      }

      // ═══ Case 2: Section exists but has structural issues ═══
      const { hasIssues, unclassifiable } = detectStructuralIssues(letter, trimmed);
      if (hasIssues && unclassifiable.length > 0) {
        // Don't delete content – append "Nezařazeno" block with unclassifiable headers
        const unclassifiedBlock = `\n\nNezařazeno – k ručnímu doplnění (${dateStr}):\n${unclassifiable.map(u => `• ${u}`).join("\n")}`;
        // Only add if not already present
        if (!existing.includes("Nezařazeno – k ručnímu doplnění")) {
          sections[letter] = existing + unclassifiedBlock;
          changes.push(`sekce ${letter} měla nesprávnou strukturu – automaticky opravena`);
          needsWrite = true;
        }
      }
    }
  }

  // ═══ Case 3 exception: STUB → FULL promotion (has thread data) ═══
  if (isStub && hasThreadData && changes.length > 0) {
    promoted = true;
    changes.push(`STUB karta povýšena na PLNOU kartu na základě vlákna z ${dateStr}`);
  }

  if (needsWrite) {
    const rebuilt = buildCard(partName, sections);
    await updateFileById(token, fileId, rebuilt, fileMimeType);
    console.log(`[AUDIT-0B] ✅ "${partName}": ${changes.length} oprav provedeno${promoted ? " (STUB→PLNÁ)" : ""}`);
  } else {
    console.log(`[AUDIT-0B] "${partName}": struktura OK, žádné opravy`);
  }

  return { partName, fileName, changes, promoted, created: false, alertForHanka: null };
}

// ═══ Case 4: Create a brand new card for a part that has no card at all ═══
async function createNewCardForPart(
  token: string,
  partName: string,
  threadMessages: any[],
  activeFolderId: string,
  registryContext: RegistryContext | null,
): Promise<AuditResult> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const userMsgs = getUserMessages(threadMessages);
  const hasEnoughData = userMsgs.length >= 3;

  // Build initial sections
  const sections: Record<string, string> = {};

  // Section A: basic identity from what we know
  sections["A"] = `Jméno: ${partName}\nStatus: Aktivní\nPrvní kontakt: ${dateStr}\n\n(Další údaje k doplnění)`;

  // Section E: chronological log
  sections["E"] = `Aktuální stav:\n✅ Aktivní – první kontakt s Karlem ${dateStr}\n\nChronologický log:\n${dateStr}\tPrvní kontakt s Karlem\tNová karta vytvořena automaticky`;

  if (hasEnoughData) {
    // FULL card: fill remaining sections with templates (AI will fill them in the main analysis)
    for (const letter of SECTION_ORDER) {
      if (!sections[letter]) {
        sections[letter] = SECTION_TEMPLATES[letter] || "(zatím prázdné)";
      }
    }
  }

  const cardType = hasEnoughData ? "PLNÁ" : "STUB";

  // Determine filename
  const nextId = getNextRegistryId(registryContext?.entries || []);
  const paddedId = String(nextId).padStart(3, "0");
  const normalizedName = partName.replace(/\s+/g, "_").toUpperCase();
  const newFileName = `${paddedId}_${normalizedName}`;

  // Create the card file
  const fullCard = buildCard(partName, sections);
  await createFileInFolder(token, newFileName, fullCard, activeFolderId);
  console.log(`[AUDIT-0B-CASE4] ✅ Nová ${cardType} karta vytvořena: ${newFileName}`);

  // Add to registry spreadsheet
  if (registryContext?.registryFileId && registryContext?.registrySheetName) {
    const added = await addRegistryRow(
      token, registryContext.registryFileId, registryContext.registrySheetName,
      paddedId, partName, "Aktivní", "", "", `Automaticky vytvořeno ${dateStr}`
    );
    if (added) {
      registryContext.entries.push({
        id: paddedId,
        name: partName,
        age: "",
        status: "Aktivní",
        cluster: "",
        note: `Automaticky vytvořeno ${dateStr}`,
        normalizedName: canonicalText(partName),
      });
    }
  }

  const alertMsg = `⚠️ Nová část nebo fragment detekován: ${partName}. Karta vytvořena (${cardType}). Doporučuji ověřit.`;

  return {
    partName,
    fileName: newFileName,
    changes: [`Nová karta vytvořena pro část ${partName} na základě vlákna z ${dateStr}. Typ: ${cardType}`],
    promoted: false,
    created: true,
    alertForHanka: alertMsg,
  };
}

// Log audit results to PAMET_KAREL_LOGS/DAILY_JOB_LOG on Drive
async function logAuditResults(token: string, rootFolderId: string, results: AuditResult[]): Promise<void> {
  const significantResults = results.filter(r => r.changes.length > 0);
  if (significantResults.length === 0) return;

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 16);
  const logLines = significantResults.map(r => {
    const prefix = r.created ? "NOVÁ KARTA" : r.promoted ? "POVÝŠENÍ STUB→PLNÁ" : "AUDIT OPRAVA";
    return `[${dateStr} ${timeStr}] ${prefix} – Karta "${r.partName}" (${r.fileName}): ${r.changes.join("; ")}`;
  });

  // Find PAMET_KAREL_LOGS folder
  try {
    const rootChildren = await listFilesInFolder(token, rootFolderId);
    // Look for PAMET_KAREL or similar
    const pametFolder = rootChildren.find(f =>
      f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("pametk")
    );
    if (!pametFolder) {
      console.warn("[AUDIT-0B-LOG] PAMET_KAREL folder not found, skipping Drive log");
      return;
    }

    const pametChildren = await listFilesInFolder(token, pametFolder.id);
    const logsFolder = pametChildren.find(f =>
      f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("log")
    );
    const targetFolderId = logsFolder?.id || pametFolder.id;

    // Find or create DAILY_JOB_LOG
    const logFileName = "DAILY_JOB_LOG";
    const existingLog = pametChildren.find(f => canonicalText(f.name).includes("dailyjoblog"));
    const logFileId = existingLog?.id ||
      (logsFolder ? (await listFilesInFolder(token, logsFolder.id)).find(f => canonicalText(f.name).includes("dailyjoblog"))?.id : null);

    const logContent = `\n\n═══ KROK 0B – AUDIT STRUKTURY (${dateStr} ${timeStr}) ═══\n${logLines.join("\n")}`;

    if (logFileId) {
      await appendToDoc(token, logFileId, logContent);
    } else {
      await createFileInFolder(token, logFileName, logContent.trim(), targetFolderId);
    }
    console.log(`[AUDIT-0B-LOG] ✅ Logged ${significantResults.length} audit results to Drive`);
  } catch (e) {
    console.warn("[AUDIT-0B-LOG] Failed to log to Drive (non-fatal):", e);
  }
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

  // ═══ EMAIL GUARD: Daily report emails must only go out in the afternoon slot (14:00 Prague) or catch-up runs ═══
  const isTestEmail = requestBody?.testEmail === true;
  const isCatchup = requestBody?.catchup === true;
  const isWatchdog = requestBody?.source === "watchdog";
  // Use Intl.DateTimeFormat for reliable Prague time in Deno edge runtime
  const pragueHourForEmailGuard = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", hour: "numeric", hour12: false }).format(new Date()),
    10
  );
  const isAfternoonCronWindow = isCronCall && pragueHourForEmailGuard >= 13;
  const shouldSendEmails = isAfternoonCronWindow || isTestEmail || isCatchup || isWatchdog;
  console.log(`[daily-cycle] Email Guard: pragueHour=${pragueHourForEmailGuard}, isCronCall=${isCronCall}, isCatchup=${isCatchup}, isWatchdog=${isWatchdog}, shouldSendEmails=${shouldSendEmails}`);

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

    // Cross-mode: Load Hana conversations from last 24h for DID-relevant mentions
    const { data: hanaConvRows } = await sb.from("karel_hana_conversations").select("*").gte("last_activity_at", cutoff24h);
    const recentHanaConversations = hanaConvRows ?? [];
    console.log(`[daily-cycle] Hana conversations (24h): ${recentHanaConversations.length}`);

    // ═══ ALL-MODE SCAN: Load client sessions, crisis briefs, client tasks from last 24h ═══
    const { data: recentClientSessionRows } = await sb.from("client_sessions")
      .select("id, client_id, session_date, notes, ai_analysis, ai_hypotheses, ai_recommended_methods, ai_risk_assessment, voice_analysis, report_key_theme, report_context, report_transference, report_risks, report_therapist_emotions, report_interventions_tried, report_next_session_goal")
      .gte("updated_at", cutoff24h);
    const recentClientSessions = recentClientSessionRows ?? [];
    console.log(`[daily-cycle] Client sessions (24h): ${recentClientSessions.length}`);

    const { data: recentCrisisBriefRows } = await sb.from("crisis_briefs")
      .select("id, scenario, risk_score, risk_overview, recommended_contact, next_steps, raw_brief, created_at")
      .gte("created_at", cutoff24h);
    const recentCrisisBriefs = recentCrisisBriefRows ?? [];
    console.log(`[daily-cycle] Crisis briefs (24h): ${recentCrisisBriefs.length}`);

    const { data: recentClientTaskRows } = await sb.from("client_tasks")
      .select("id, task, method, status, notes, result, due_date, updated_at")
      .gte("updated_at", cutoff24h);
    const recentClientTasks = recentClientTaskRows ?? [];
    console.log(`[daily-cycle] Client tasks (24h): ${recentClientTasks.length}`);

    // Load ALL research threads (not just DID-relevant – Karel must scan everything)
    const { data: researchThreadRows } = await sb.from("research_threads").select("*").eq("is_deleted", false).gte("last_activity_at", cutoff24h);
    const researchThreads = researchThreadRows ?? [];
    console.log(`[daily-cycle] Research threads (24h): ${researchThreads.length}`);

    // ═══ ALL-MODE: DID meetings from last 24h ═══
    const { data: recentMeetingRows } = await sb.from("did_meetings")
      .select("id, topic, agenda, status, messages, outcome_summary, triggered_by, created_at, updated_at")
      .gte("updated_at", cutoff24h);
    const recentMeetings = recentMeetingRows ?? [];
    console.log(`[daily-cycle] DID meetings (24h): ${recentMeetings.length}`);

    // ═══ ALL-MODE: Recent episodes from last 24h ═══
    const { data: recentEpisodeRows } = await sb.from("karel_episodes")
      .select("id, domain, summary_karel, summary_user, tags, participants, emotional_intensity, hana_state, actions_taken, derived_facts, outcome, timestamp_start")
      .gte("timestamp_start", cutoff24h);
    const recentEpisodes = recentEpisodeRows ?? [];
    console.log(`[daily-cycle] Episodes (24h): ${recentEpisodes.length}`);

    // ═══ ALL-MODE: Pulse checks from last 7 days ═══
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentPulseRows } = await sb.from("did_pulse_checks")
      .select("respondent, team_feeling, priority_clarity, karel_feedback, week_start, created_at")
      .gte("created_at", weekAgo);
    const recentPulseChecks = recentPulseRows ?? [];
    console.log(`[daily-cycle] Pulse checks (7d): ${recentPulseChecks.length}`);

    // Load pending therapist tasks for accountability analysis
    const { data: pendingTasks } = await sb.from("did_therapist_tasks")
      .select("task, detail_instruction, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, note")
      .neq("status", "done")
      .order("created_at", { ascending: true });
    const pendingTasksSummary = (pendingTasks || []).map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
      return `- [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}${age >= 3 ? " ⚠️ ESKALACE" : ""}`;
    }).join("\n");
    console.log(`[daily-cycle] Pending therapist tasks: ${pendingTasks?.length || 0}`);

    // ═══ THERAPIST PROFILING: Silent load of motivation profiles for both therapists ═══
    const { data: motivationProfileRows } = await sb.from("did_motivation_profiles")
      .select("therapist, preferred_style, praise_effectiveness, deadline_effectiveness, instruction_effectiveness, streak_current, streak_best, tasks_completed, tasks_missed, avg_completion_days, last_active_at, notes");
    const motivationProfiles = motivationProfileRows ?? [];
    console.log(`[daily-cycle] Motivation profiles loaded: ${motivationProfiles.length}`);
    const therapistProfileContext = motivationProfiles.map((p: any) => {
      const completionRate = (p.tasks_completed + p.tasks_missed) > 0
        ? Math.round((p.tasks_completed / (p.tasks_completed + p.tasks_missed)) * 100)
        : 0;
      return `═ Profil terapeuta: ${p.therapist} ═
Preferovaný styl vedení: ${p.preferred_style}
Efektivita motivace – pochvaly: ${p.praise_effectiveness}/5, termíny: ${p.deadline_effectiveness}/5, instrukce: ${p.instruction_effectiveness}/5
Streak (aktuální/nejlepší): ${p.streak_current}/${p.streak_best}
Splněno úkolů: ${p.tasks_completed}, nesplněno: ${p.tasks_missed} (úspěšnost: ${completionRate}%)
Průměrná doba splnění: ${p.avg_completion_days || "?"} dní
Poslední aktivita: ${p.last_active_at || "neznámo"}
Poznámky Karla: ${p.notes || "(žádné)"}`;
    }).join("\n\n");

    // ═══ SLOT-BASED COOLDOWN + CATCH-UP: Allow both 06:00 and 14:00 CET cycles ═══
    // INVARIANT: Každý příjemce (hanka, kata) dostane MAXIMÁLNĚ 1 denní report za den.
    // Toto je garantováno tabulkou did_daily_report_dispatches (recipient + report_date unikát).
    // Catch-up crony (15:30, 17:00 CET) re-spouštějí cyklus pokud 14:00 selhal (503 apod.),
    // ale reserveDispatchSlot VŽDY zkontroluje, zda mail pro daný den už nebyl odeslán.
    const isManualTrigger = !isCronCall || requestBody?.source === "manual";

    if (!isManualTrigger) {
      const pragueHour = parseInt(
        new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", hour: "numeric", hour12: false }).format(new Date()),
        10
      );
      // Morning slot: 04:00-12:59 CET  |  Afternoon slot: 13:00-23:59 CET
      const currentSlot = pragueHour < 13 ? "morning" : "afternoon";

      // ═══ CATCH-UP FAST PATH: If this is an afternoon catch-up cron (15:30 / 17:00)
      // and BOTH dispatches are already "sent" for today → skip entirely (no work needed)
      if (currentSlot === "afternoon") {
        const { data: todayDispatches } = await sb.from("did_daily_report_dispatches")
          .select("recipient, status")
          .eq("report_date", reportDatePrague);
        const sentRecipients = new Set(
          (todayDispatches || []).filter((d: any) => d.status === "sent").map((d: any) => d.recipient)
        );
        if (sentRecipients.has("hanka") && sentRecipients.has("kata")) {
          console.log(`[daily-cycle] CATCH-UP: Both dispatches already sent for ${reportDatePrague}, nothing to do.`);
          return new Response(JSON.stringify({
            success: true,
            skipped: true,
            reason: "all_dispatches_sent",
            date: reportDatePrague,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // If we get here, at least one dispatch is missing → proceed with full cycle
        if (sentRecipients.size > 0) {
          console.log(`[daily-cycle] CATCH-UP: Partial delivery detected (sent: ${[...sentRecipients].join(",")}). Re-running to complete missing.`);
        } else {
          console.log(`[daily-cycle] CATCH-UP: No dispatches found for ${reportDatePrague}. Running full cycle.`);
        }
      }

      // Check if THIS SLOT already has a completed cycle (6h cooldown per slot)
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data: recentSlotCycles } = await sb.from("did_update_cycles")
        .select("id, completed_at, status, started_at")
        .eq("cycle_type", "daily")
        .eq("status", "completed")
        .gte("started_at", sixHoursAgo)
        .order("completed_at", { ascending: false })
        .limit(1);

      if (recentSlotCycles && recentSlotCycles.length > 0) {
        const lastCycleTime = new Date(new Date(recentSlotCycles[0].started_at).toLocaleString("en-US", { timeZone: "Europe/Prague" }));
        const lastCycleHour = lastCycleTime.getHours();
        const lastCycleSlot = lastCycleHour < 13 ? "morning" : "afternoon";
        
        if (lastCycleSlot === currentSlot) {
          // ═══ CATCH-UP OVERRIDE: Even if cycle completed, check if emails were actually delivered
          // (cycle can "complete" with cards but email sending may have failed/503'd)
          if (currentSlot === "afternoon") {
            const { data: dispatchCheck } = await sb.from("did_daily_report_dispatches")
              .select("recipient, status")
              .eq("report_date", reportDatePrague);
            const sentCheck = new Set(
              (dispatchCheck || []).filter((d: any) => d.status === "sent").map((d: any) => d.recipient)
            );
            if (!sentCheck.has("hanka") || !sentCheck.has("kata")) {
              console.log(`[daily-cycle] CATCH-UP OVERRIDE: Cycle completed but dispatches incomplete (sent: ${[...sentCheck].join(",") || "none"}). Allowing re-run for email delivery.`);
              // Don't return – proceed with the cycle to attempt email delivery
            } else {
              console.log(`[daily-cycle] Slot cooldown: ${currentSlot} slot completed + all dispatches sent. Skipping.`);
              return new Response(JSON.stringify({
                success: true,
                skipped: true,
                reason: `cooldown_slot_${currentSlot}`,
                lastCompletedAt: recentSlotCycles[0].completed_at,
                cycleId: recentSlotCycles[0].id,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          } else {
            console.log(`[daily-cycle] Slot cooldown: ${currentSlot} slot already completed (cycle ${recentSlotCycles[0].id}), skipping.`);
            return new Response(JSON.stringify({
              success: true,
              skipped: true,
              reason: `cooldown_slot_${currentSlot}`,
              lastCompletedAt: recentSlotCycles[0].completed_at,
              cycleId: recentSlotCycles[0].id,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
        console.log(`[daily-cycle] Different slot: last was ${lastCycleSlot}, now is ${currentSlot} – proceeding.`);
      }
    }

    // ═══ CONCURRENCY: Prevent parallel runs ═══
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: runningDailyCycle } = await sb.from("did_update_cycles")
      .select("id, started_at")
      .eq("cycle_type", "daily")
      .eq("status", "running")
      .gte("started_at", tenMinAgo)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runningDailyCycle) {
      console.log(`[daily-cycle] Already running: cycle ${runningDailyCycle.id} since ${runningDailyCycle.started_at}, skipping.`);
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: "already_running",
        cycleId: runningDailyCycle.id,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ AUTO-CLEANUP: Mark stuck "running" daily cycles as "failed" ═══
    const { data: stuckDailyCycles } = await sb.from("did_update_cycles")
      .select("id")
      .eq("cycle_type", "daily")
      .eq("status", "running")
      .lt("started_at", tenMinAgo);
    if (stuckDailyCycles && stuckDailyCycles.length > 0) {
      for (const stuck of stuckDailyCycles) {
        await sb.from("did_update_cycles").update({ status: "failed", completed_at: new Date().toISOString() }).eq("id", stuck.id);
      }
      console.log(`[daily-cycle] Auto-cleanup: ${stuckDailyCycles.length} stuck daily cycles marked failed`);
    }

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
    let finalReportText = "";
    let aiReportText = "";
    let hankaHtml = "";
    let kataHtml = "";

    // ═══ KROK 0B – AUDIT STRUKTURY KARTY PŘED ZPRACOVÁNÍM ═══
    // Povinný krok: pro každé nezpracované vlákno audituje strukturu odpovídající karty
    // Handles: Case 1 (missing sections), Case 2 (malformed structure), Case 3 (STUB promotion), Case 4 (no card exists)
    const auditResults: AuditResult[] = [];
    const auditAlerts: string[] = []; // ⚠️ alerts for Hanka's daily report
    if (folderId && registryContext && threads.length > 0) {
      console.log(`[KROK-0B] Starting structural audit for ${threads.length} unprocessed thread(s)...`);
      const auditedParts = new Set<string>();

      for (const thread of threads) {
        if ((thread.sub_mode || "cast") !== "cast") continue; // audit only "cast" threads
        const partName = normalizePartHint(thread.part_name || "");
        if (!partName || auditedParts.has(canonicalText(partName))) continue;
        auditedParts.add(canonicalText(partName));

        try {
          const target = await resolveCardTarget(token, folderId, partName, registryContext);
          const lookupName = target.registryEntry?.name || partName;

          if (!target.registryEntry) {
            // ═══ Case 4: Part has NO registry entry AND no card → create new card ═══
            console.log(`[KROK-0B] "${partName}": mimo registr – vytvářím novou kartu (Case 4)`);
            if (registryContext.activeFolderId) {
              try {
                const result = await createNewCardForPart(
                  token, partName,
                  Array.isArray(thread.messages) ? thread.messages as any[] : [],
                  registryContext.activeFolderId,
                  registryContext,
                );
                auditResults.push(result);
                cardsUpdated.push(`${partName} (AUDIT-0B: NOVÁ KARTA – ${result.created ? "vytvořena" : "chyba"})`);
                if (result.alertForHanka) {
                  auditAlerts.push(result.alertForHanka);
                }
              } catch (e) {
                console.error(`[KROK-0B] Case 4 failed for "${partName}":`, e);
              }
            }
            continue;
          }

          const card = await findCardFile(token, lookupName, target.searchRootId);
          if (card) {
            // Cases 1, 2, 3: Audit existing card structure
            const hasThreadMsgs = Array.isArray(thread.messages) && (thread.messages as any[]).filter((m: any) => m?.role === "user").length >= 2;
            const result = await auditCardStructure(token, card.fileId, card.fileName, card.mimeType, lookupName, hasThreadMsgs);
            auditResults.push(result);
            if (result.changes.length > 0) {
              cardsUpdated.push(`${lookupName} (AUDIT-0B: ${result.changes.length} oprav${result.promoted ? ", STUB→PLNÁ" : ""})`);
            }
            if (result.alertForHanka) {
              auditAlerts.push(result.alertForHanka);
            }
          } else {
            // ═══ Case 4b: Registry entry exists but no card file found → create card ═══
            console.log(`[KROK-0B] "${lookupName}": v registru ale karta nenalezena – vytvářím (Case 4b)`);
            if (registryContext.activeFolderId) {
              try {
                const result = await createNewCardForPart(
                  token, lookupName,
                  Array.isArray(thread.messages) ? thread.messages as any[] : [],
                  registryContext.activeFolderId,
                  registryContext,
                );
                auditResults.push(result);
                cardsUpdated.push(`${lookupName} (AUDIT-0B: KARTA VYTVOŘENA – chyběla na Drive)`);
                if (result.alertForHanka) {
                  auditAlerts.push(result.alertForHanka);
                }
              } catch (e) {
                console.error(`[KROK-0B] Case 4b failed for "${lookupName}":`, e);
              }
            }
          }
        } catch (e) {
          console.warn(`[KROK-0B] Audit error for "${partName}":`, e);
        }
      }

      // Log audit results to Drive
      if (auditResults.length > 0) {
        try {
          await logAuditResults(token, folderId, auditResults);
        } catch (e) {
          console.warn("[KROK-0B] Drive logging failed (non-fatal):", e);
        }
      }

      const totalChanges = auditResults.reduce((sum, r) => sum + r.changes.length, 0);
      const promotions = auditResults.filter(r => r.promoted).length;
      const newCards = auditResults.filter(r => r.created).length;
      console.log(`[KROK-0B] ✅ Audit complete: ${auditResults.length} karet zkontrolováno, ${totalChanges} oprav, ${promotions} povýšení STUB→PLNÁ, ${newCards} nových karet`);

      // Update cycle progress
      if (cycleId) {
        await sb.from("did_update_cycles").update({
          phase: "audit_0b",
          phase_detail: `Audit: ${auditResults.length} karet, ${totalChanges} oprav, ${newCards} nových`,
          heartbeat_at: new Date().toISOString(),
        }).eq("id", cycleId);
      }
    }

    // Use allRecentThreads for report generation, but threads (unprocessed) for card updates
    const hasRecentActivity = allRecentThreads.length > 0 || allRecentConversations.length > 0 || recentHanaConversations.length > 0 || recentClientSessions.length > 0 || recentCrisisBriefs.length > 0 || researchThreads.length > 0 || recentClientTasks.length > 0 || recentMeetings.length > 0 || recentEpisodes.length > 0;

    // ═══ CRITICAL FIX: Manual triggers ALWAYS run full analysis using allRecentThreads ═══
    // Previously, manual triggers with no unprocessed threads returned early, skipping CENTRUM updates entirely.
    if (threads.length === 0 && conversations.length === 0 && !hasRecentActivity) {
      // Truly nothing to process — no activity at all in 24h
      if (cycle) {
        await sb.from("did_update_cycles").update({
          status: "completed",
          completed_at: new Date().toISOString(),
          report_summary: normalizedCardFiles.length > 0
            ? `Normalizováno ${normalizedCardFiles.length} karet na strukturu A–M.`
            : "Žádná aktivita za posledních 24h",
          cards_updated: cardsUpdated,
        }).eq("id", cycle.id);
      }

      if (shouldSendEmails) {
        // Truly quiet day email
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
                    { role: "system", content: SYSTEM_RULES + `\n\nJsi Karel – vedoucí terapeutického týmu pro DID. Vygeneruj krátký denní report pro celý tým. Profesionální, věcný tón vedoucího.
Formát HTML emailu. Dnes nebyla žádná nová aktivita částí ani konverzace. Napiš klidný report:
- Shrnutí stavu (klidný den, žádná aktivita)
- Případné připomenutí otevřených úkolů
- Povzbuzení pro tým
KRITICKÁ PRAVIDLA:
- Oslovuj: "Hani", "Haničko", "Káťo" – NIKDY "miláčku", "lásko", "drahá"
- NIKDY nezařazuj soukromé emoční stavy terapeutek
- Locík je PES, NE DID část. Káťa je TERAPEUTKA, NE DID část.
Datum: ${dateStr}` },
                    { role: "user", content: "Vygeneruj klidný denní report." },
                  ],
                }),
              });
              if (hankaRes.ok) {
                const hankaData = await hankaRes.json();
                hankaHtml = hankaData.choices?.[0]?.message?.content || "";
              }
            } catch (e) { console.warn("[quiet-day] Hanka email gen failed:", e); }

            let kataHtml = "";
            try {
              const kataRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: SYSTEM_RULES + `\n\nJsi Karel – vedoucí terapeutického týmu. Vygeneruj krátký denní report pro Káťu. Profesionální, vstřícný tón.
Formát HTML emailu. Dnes nebyla žádná nová aktivita částí ani konverzace. Napiš klidný report:
- Shrnutí stavu (klidný den)
- Připomenutí otevřených úkolů pokud existují
KRITICKÁ PRAVIDLA:
- Oslovuj: "Káťo" – NIKDY "miláčku", "lásko", "drahá"
- NIKDY nezařazuj soukromé emoční stavy terapeutek
- Locík je PES, NE DID část. Káťa je TERAPEUTKA, NE DID část.
Datum: ${dateStr}` },
                    { role: "user", content: "Vygeneruj klidný denní report." },
                  ],
                }),
              });
              if (kataRes.ok) {
                const kataData = await kataRes.json();
                kataHtml = kataData.choices?.[0]?.message?.content || "";
              }
            } catch (e) { console.warn("[quiet-day] Kata email gen failed:", e); }

            let quietEmailSentToHanka = false;
            let quietEmailSentToKata = false;
            if (hankaHtml) {
              quietEmailSentToHanka = await sendEmailOnce("hanka", MAMKA_EMAIL, `Karel – Klidný den (${dateStr})`, hankaHtml);
            }
            if (kataHtml && KATA_EMAIL) {
              quietEmailSentToKata = await sendEmailOnce("kata", KATA_EMAIL, `Karel – Klidný den (${dateStr})`, kataHtml);
            }
          }
        } catch (e) { console.error("[quiet-day] Email error:", e); }
      }

      return new Response(JSON.stringify({
        success: true,
        message: "Žádná aktivita za posledních 24h",
        threadsProcessed: 0,
        conversationsProcessed: 0,
        cardsUpdated,
        reportSent: false,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ ALWAYS use allRecentThreads for analysis when unprocessed ones are empty ═══
    // This ensures manual triggers and cron triggers both get full CENTRUM document updates
    const reportThreads = threads.length > 0 ? threads : allRecentThreads;
    const reportConversations = conversations.length > 0 ? conversations : allRecentConversations;
    
    console.log(`[daily-cycle] Processing: ${reportThreads.length} threads (${threads.length} unprocessed), ${reportConversations.length} conversations (${conversations.length} unprocessed), hasRecentActivity=${hasRecentActivity}`);

    // 3. COMPILE THREAD + CONVERSATION DATA (token-safe, truncated)
    const clip = (v: string, max = 600) => (v.length > max ? `${v.slice(0, max)}…` : v);

    const allowedRegistryNames = new Set(
      (registryContext?.entries || []).map((entry) => canonicalText(entry.name)).filter(Boolean)
    );

    const threadSummaries = reportThreads.map((t) => {
      const allMsgs = ((t.messages as any[]) || []).slice(-30);
      const userMsgs = allMsgs.filter((m: any) => m?.role === "user" && typeof m?.content === "string");

      const isCastMode = (t.sub_mode || "cast") === "cast";
      const userLabel = isCastMode ? "ČÁST" : "TERAPEUT";
      const modeNote = isCastMode
        ? ""
        : `\n⚠️ REŽIM "${t.sub_mode}": Uživatel je terapeut, zmínky o částech v tomto vlákně nejsou důkaz aktivace.`;

      let detectedSwitch = "";
      if (isCastMode) {
        for (let i = userMsgs.length - 1; i >= 0; i--) {
          const candidate = detectExplicitSelfIdentification(userMsgs[i].content || "");
          if (!candidate) continue;
          const candidateCanonical = canonicalText(candidate);
          if (allowedRegistryNames.size > 0 && !allowedRegistryNames.has(candidateCanonical)) continue;
          const originalCanonical = canonicalText(t.part_name || "");
          if (candidateCanonical && candidateCanonical !== originalCanonical) {
            detectedSwitch = candidate;
          }
          break;
        }
      }

      const switchNote = detectedSwitch
        ? `\n⚠️ SWITCH DETEKOVÁN (ověřený): vlákno "${t.part_name}" se v průběhu představilo jako "${detectedSwitch}".`
        : "";

      const userTranscript = userMsgs
        .slice(-12)
        .map((m: any) => `[${userLabel}]: ${clipText(m.content || "", 320)}`)
        .join("\n");

      return `=== Vlákno: ${t.part_name} (${t.sub_mode}) ===${modeNote}${switchNote}\nJazyk: ${t.part_language}\nZačátek: ${t.started_at}\nPoslední aktivita: ${t.last_activity_at}\nPočet USER zpráv: ${userMsgs.length}\n\nUSER KONVERZACE (jediný důkazní zdroj):\n${userTranscript || "(bez user zpráv)"}`;
    }).join("\n\n---\n\n");

    const convSummaries = reportConversations.map((c) => {
      const userMsgs = (((c.messages as any[]) || []).filter((m: any) => m?.role === "user" && typeof m?.content === "string")).slice(-12);
      return `=== Konverzace: ${c.sub_mode} (${c.label}) ===\nUloženo: ${c.saved_at}\n\nUSER KONVERZACE:\n${userMsgs.map((m: any) => `[UŽIVATEL]: ${clipText(m.content || "", 320)}`).join("\n") || "(bez user zpráv)"}`;
    }).join("\n\n---\n\n");

    // Compile DID-relevant research thread summaries
    const researchSummaries = researchThreads.map((rt: any) => {
      const msgs = ((rt.messages as any[]) || []).slice(-15);
      return `=== Profesní zdroj: ${rt.topic} (autor: ${rt.created_by}) ===\nVytvořeno: ${rt.created_at}\nPoslední aktivita: ${rt.last_activity_at}\n\nKlíčové body:\n${msgs.map((m: any) => `[${m.role === "user" ? "TERAPEUT" : "KAREL"}]: ${typeof m.content === "string" ? clip(m.content, 400) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    // Cross-mode: Compile Hana conversation summaries for DID-relevant mentions
    const hanaSummaries = recentHanaConversations.map((hc: any) => {
      const msgs = ((hc.messages as any[]) || []).filter((m: any) => m?.role === "user" && typeof m?.content === "string").slice(-10);
      if (msgs.length === 0) return "";
      return `=== Režim HANA: Konverzace (${hc.current_domain}, stav: ${hc.current_hana_state}) ===\nZačátek: ${hc.started_at}\nPoslední aktivita: ${hc.last_activity_at}\n\n${msgs.map((m: any) => `[HANA/TERAPEUT]: ${clipText(m.content || "", 300)}`).join("\n")}`;
    }).filter(Boolean).join("\n\n---\n\n");

    // ═══ ALL-MODE: Client sessions summaries ═══
    const clientSessionSummaries = recentClientSessions.map((cs: any) => {
      const parts = [
        cs.report_key_theme ? `Klíčové téma: ${cs.report_key_theme}` : "",
        cs.report_context ? `Kontext: ${clip(cs.report_context, 300)}` : "",
        cs.notes ? `Poznámky: ${clip(cs.notes, 400)}` : "",
        cs.ai_analysis ? `AI analýza: ${clip(cs.ai_analysis, 400)}` : "",
        cs.ai_hypotheses ? `Hypotézy: ${clip(cs.ai_hypotheses, 300)}` : "",
        cs.ai_recommended_methods ? `Doporučené metody: ${clip(cs.ai_recommended_methods, 300)}` : "",
        cs.ai_risk_assessment ? `Rizika: ${clip(cs.ai_risk_assessment, 200)}` : "",
        cs.voice_analysis ? `Hlasová analýza: ${clip(cs.voice_analysis, 200)}` : "",
        cs.report_transference ? `Přenos: ${clip(cs.report_transference, 200)}` : "",
        cs.report_interventions_tried ? `Intervence: ${clip(cs.report_interventions_tried, 200)}` : "",
        cs.report_next_session_goal ? `Cíl příštího sezení: ${cs.report_next_session_goal}` : "",
        (cs.report_risks || []).length > 0 ? `Rizika: ${cs.report_risks.join(", ")}` : "",
        (cs.report_therapist_emotions || []).length > 0 ? `Emoce terapeuta: ${cs.report_therapist_emotions.join(", ")}` : "",
      ].filter(Boolean);
      if (parts.length === 0) return "";
      return `=== Klientské sezení (${cs.session_date}) ===\n${parts.join("\n")}`;
    }).filter(Boolean).join("\n\n---\n\n");

    // ═══ ALL-MODE: Crisis briefs summaries ═══
    const crisisBriefSummaries = recentCrisisBriefs.map((cb: any) => {
      return `=== Krizový brief (${cb.created_at}) ===\nScénář: ${cb.scenario}\nRiziko: ${cb.risk_score}/10\nPřehled rizik: ${clip(cb.risk_overview || "", 300)}\nDoporučený kontakt: ${cb.recommended_contact}\nDalší kroky: ${(cb.next_steps || []).join("; ")}\n${cb.raw_brief ? `Detail: ${clip(cb.raw_brief, 400)}` : ""}`;
    }).filter(Boolean).join("\n\n---\n\n");

    // ═══ ALL-MODE: Client tasks summaries ═══
    const clientTaskSummaries = recentClientTasks.map((ct: any) => {
      return `- Úkol: ${ct.task} | Metoda: ${ct.method || "?"} | Stav: ${ct.status} | Poznámky: ${clip(ct.notes || "", 150)}${ct.result ? ` | Výsledek: ${clip(ct.result, 150)}` : ""}`;
    }).filter(Boolean).join("\n");

    // ═══ ALL-MODE: DID meeting summaries ═══
    const meetingSummaries = recentMeetings.map((m: any) => {
      const msgs = ((m.messages as any[]) || []).slice(-10);
      const msgText = msgs.map((msg: any) => `[${msg.therapist || msg.role}]: ${clipText(msg.content || "", 300)}`).join("\n");
      return `=== DID Porada: ${m.topic} (status: ${m.status}, triggered: ${m.triggered_by}) ===\nVytvořeno: ${m.created_at}\nAgenda: ${m.agenda || "?"}\n${m.outcome_summary ? `Výsledek: ${m.outcome_summary}` : ""}\n\nZprávy:\n${msgText || "(prázdné)"}`;
    }).filter(Boolean).join("\n\n---\n\n");

    // ═══ ALL-MODE: Episode summaries ═══
    const episodeSummaries = recentEpisodes.map((ep: any) => {
      return `- Epizoda (${ep.domain}): ${clip(ep.summary_karel || ep.summary_user || "", 300)} | účastníci: ${(ep.participants || []).join(",")} | tagy: ${(ep.tags || []).join(",")} | intenzita: ${ep.emotional_intensity}/5 | stav: ${ep.hana_state}`;
    }).filter(Boolean).join("\n");

    // ═══ ALL-MODE: Pulse check summaries ═══
    const pulseSummaries = recentPulseChecks.map((pc: any) => {
      return `- Pulse (${pc.respondent}, ${pc.week_start}): tým=${pc.team_feeling}/5, priority=${pc.priority_clarity}/5${pc.karel_feedback ? ` | Karel: ${clip(pc.karel_feedback, 150)}` : ""}`;
    }).filter(Boolean).join("\n");

    const allSummaries = [
      threadSummaries, 
      convSummaries, 
      hanaSummaries ? `\n\n=== KONVERZACE Z REŽIMU HANA (cross-mode scan) ===\n\n${hanaSummaries}` : "",
      researchSummaries ? `\n\n=== PROFESNÍ ZDROJE (Research vlákna – posledních 24h) ===\n\n${researchSummaries}` : "",
      clientSessionSummaries ? `\n\n=== KLIENTSKÁ SEZENÍ (posledních 24h) ===\n\n${clientSessionSummaries}` : "",
      crisisBriefSummaries ? `\n\n=== KRIZOVÉ BRIEFY (posledních 24h) ===\n\n${crisisBriefSummaries}` : "",
      clientTaskSummaries ? `\n\n=== ÚKOLY KLIENTŮ (posledních 24h) ===\n\n${clientTaskSummaries}` : "",
      meetingSummaries ? `\n\n=== DID PORADY (posledních 24h) ===\n\n${meetingSummaries}` : "",
      episodeSummaries ? `\n\n=== EPIZODICKÁ PAMĚŤ (posledních 24h) ===\n\n${episodeSummaries}` : "",
      pulseSummaries ? `\n\n=== PULSE CHECKS TERAPEUTŮ (posledních 7 dní) ===\n\n${pulseSummaries}` : "",
      therapistProfileContext ? `\n\n=== PROFILACE TERAPEUTŮ (dlouhodobá) ===\n\n${therapistProfileContext}` : "",
      pendingTasksSummary ? `\n\n=== NESPLNĚNÉ ÚKOLY TERAPEUTŮ ===\n\n${pendingTasksSummary}` : "",
    ].filter(Boolean).join("\n\n");

    const registryCanonicalParts = new Set(
      (registryContext?.entries || []).map((entry) => canonicalText(entry.name)).filter(Boolean)
    );
    const registryContextText = (registryContext?.entries || []).length > 0
      ? registryContext!.entries
          .slice(0, 120)
          .map((entry) => `- ${entry.id || "???"} | ${entry.name} | status: ${entry.status || "neuvedeno"}`)
          .join("\n")
      : "(registr nedostupný)";

    const knownThreadParts = new Set(
      reportThreads
        .filter((t) => (t.sub_mode || "cast") === "cast")
        .map((t) => canonicalText(normalizePartHint(t.part_name || "")))
        .filter((name) => {
          if (!name) return false;
          if (registryCanonicalParts.size === 0) return true;
          return registryCanonicalParts.has(name);
        })
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
          // Flat docs in CENTRUM (Dashboard, Index, Instrukce, Geografie, Mapa)
          const flatDocNames = ["00_Aktualni_Dashboard", "01_Index_Vsech_Casti", "02_Instrukce", "03_Vnitrni_Svet", "04_Mapa_Vztahu"];
          const centerFiles = await listFilesInFolder(token, centerFolder.id);
          for (const docName of flatDocNames) {
            const canonical = canonicalText(docName);
            const file = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && (canonicalText(f.name).includes(canonical) || f.name.includes(docName)));
            if (file) {
              try {
                const content = await readFileContent(token, file.id);
                const trimmed = content.length > 3000 ? content.slice(0, 3000) + "…" : content;
                centrumDocsContext += `\n=== EXISTUJÍCÍ CENTRUM DOC: ${file.name} ===\n${trimmed}\n`;
              } catch {}
            }
          }
          
          // Read DID_Therapist_Tasks sheet if present
          const tasksSheet = centerFiles.find(f => f.mimeType === DRIVE_SHEET_MIME && /therapist.?task/i.test(f.name));
          if (tasksSheet) {
            try {
              const exportRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${tasksSheet.id}/export?mimeType=text/csv&supportsAllDrives=true`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (exportRes.ok) {
                const csv = await exportRes.text();
                const trimmed = csv.length > 2000 ? csv.slice(0, 2000) + "…" : csv;
                centrumDocsContext += `\n=== DID_Therapist_Tasks (Drive Sheet) ===\n${trimmed}\n`;
              }
            } catch {}
          }
          
          // Read docs from 05_PLAN subfolder
          const planFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^05.*plan/i.test(f.name) || canonicalText(f.name).includes("05plan")));
          if (planFolder) {
            const planFiles = await listFilesInFolder(token, planFolder.id);
            for (const pf of planFiles) {
              if (pf.mimeType === DRIVE_FOLDER_MIME) continue;
              try {
                const content = await readFileContent(token, pf.id);
                const trimmed = content.length > 3000 ? content.slice(0, 3000) + "…" : content;
                centrumDocsContext += `\n=== EXISTUJÍCÍ CENTRUM DOC (05_PLAN): ${pf.name} ===\n${trimmed}\n`;
              } catch {}
            }
            console.log(`[daily-cycle] Loaded 05_PLAN subfolder docs`);
          }
          
          // Read last 5 interventions from 06_INTERVENCE
          const interFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^06.*intervenc/i.test(f.name) || canonicalText(f.name).includes("intervenc")));
          if (interFolder) {
            const interFiles = await listFilesInFolder(token, interFolder.id);
            const sorted = interFiles.filter(f => f.mimeType !== DRIVE_FOLDER_MIME).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 5);
            for (const sf of sorted) {
              try {
                const content = await readFileContent(token, sf.id);
                const trimmed = content.length > 2000 ? content.slice(0, 2000) + "…" : content;
                centrumDocsContext += `\n=== INTERVENCE: ${sf.name} ===\n${trimmed}\n`;
              } catch {}
            }
          }
          
          // Read last 3 agreements from 07_DOHODY
          const dohodaFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && (/^07/.test(f.name.trim()) || canonicalText(f.name).includes("dohod")));
          if (dohodaFolder) {
            const dohodaFiles = await listFilesInFolder(token, dohodaFolder.id);
            let totalDohodaChars = 0;
            const MAX_DOHODA_CHARS = 6000;
            for (const sf of dohodaFiles.sort((a, b) => b.name.localeCompare(a.name))) {
              if (totalDohodaChars >= MAX_DOHODA_CHARS) break;
              try {
                const content = await readFileContent(token, sf.id);
                const trimmed = content.length > 2000 ? content.slice(0, 2000) + "…" : content;
                centrumDocsContext += `\n=== DOHODA: ${sf.name} ===\n${trimmed}\n`;
                totalDohodaChars += trimmed.length;
              } catch {}
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
            content: SYSTEM_RULES + `\n\nJsi Karel – analytik DID systému a terapeutický supervizor. Zpracuj data z rozhovorů a rozlož KAŽDOU informaci do správných sekcí karet částí.

═══ KRITICKÉ PRAVIDLO: DETEKCE SWITCHŮ VE VLÁKNECH ═══
⚠️ Pokud je ve vlákně označen SWITCH (např. "vlákno začalo jako Lincoln ale část se představila jako Adam"):
- NEPIŠ kartu pro původní část (Lincoln), ale pro SKUTEČNOU část (Adam)
- Pokud se část pouze PŘEDSTAVILA na začátku a pak se přepnula, celý rozhovor patří NOVÉ části
- V [REPORT] uveď: "Ve vlákně [part_name] došlo ke switchi na [nová_část]"

═══ KRITICKÉ PRAVIDLO: BIOLOGICKÉ OSOBY vs DID ČÁSTI ═══
⚠️ ABSOLUTNÍ PRIORITA: Následující osoby NEJSOU části DID systému, jsou to reální lidé. NIKDY pro ně NEVYTVÁŘEJ [KARTA:...] blok:
- Amálka (7 let) – biologická dcera Káti a Jiřího
- Tonička (4 roky) – biologická dcera Káti a Jiřího  
- Jiří – Kátin manžel
- Káťa / Katka / Kája – druhý terapeut, Hančina biologická dcera
- Hanka / Hanička / Hana – první terapeut

⚠️ ALIASY – VŠECHNY ZNAMENAJÍ AMÁLKU + TONIČKU (biologické děti, NE DID části):
"holky" = "holčičky" = "děti Káti" = "děti" = "Káťiny děti" = "Káťiny holky" = "malé" = "ty dvě" = "kluci a holky" (pokud kontext = rodina)
- Jakékoli jméno z tohoto seznamu NESMÍ mít vlastní [KARTA:] blok
- Pokud si nejsi jistý zda jméno je část nebo reálná osoba, NEZAPISUJ kartu a zmíň to v [REPORT]

═══ KRITICKÉ PRAVIDLO: ROZLIŠUJ "ZMÍNĚNO" vs "AKTIVNÍ" ═══
⚠️ Pokud terapeut (Hanka/Káťa) v rozhovoru ZMÍNÍ jméno části (např. "Jak se má Anička?"), to NEZNAMENÁ že se část probudila nebo je aktivní!
- "Zmíněno v rozhovoru" ≠ "Část je aktivní"
- Pouze pokud část SAMA komunikuje (má vlastní zprávy s role "user" v režimu "cast"), je aktivní

⚠️ NIKDY NEZADÁVEJ NESPLNITELNÉ ÚKOLY:
- ❌ "Pracuj s Bélou na stabilizaci" (Bélo je dormantní = nelze s ním pracovat!)
- ✅ "Monitoruj signály případného probuzení Bély"
- Spící/dormantní části NELZE aktivně zapojit do terapie – pouze monitoring a příprava!

═══ KROK 0 – PŘÍPRAVA (POVINNÝ) ═══

Před zápisem do karet MUSÍŠ provést přípravnou fázi:
1. Přečti si CELÉ vlákno (všechny zprávy) pro každou část
2. Vytvoř si interní pracovní poznámky – roztřiď informace z vláken podle sekcí A-M architektury karty
3. Tento přípravný blok NEVYPISUJ ve výstupu – je to tvůj vnitřní pracovní nástroj
4. Teprve po tomto roztřídění začni generovat [KARTA:] bloky

═══ POSTUP AKTUALIZACE SEKCÍ A-M ═══

Pro KAŽDOU část, která komunikovala ve vlákně, čti existující kartu a proveď aktualizaci každé sekce podle těchto pravidel:

SEKCE A – Aktuální stav a profil části [REŽIM: REPLACE pro odstavec "Aktuální stav", APPEND pro ostatní]

a) AKTUÁLNÍ STAV (celý odstavec se NAHRAZUJE):
- Nahraď datum za datum z posledního vlákna
- Nahraď stávající popis aktuálního stavu novým popisem, který přesně vystihuje momentální rozpoložení části
  Příklad: "Vyděšený po noční můře, oslovil Karla ráno po probuzení"

b) PODVĚDOMÍ O SYSTÉMU / ROLE / VNITŘNÍ KONFLIKT:
- Analyzuj, zda vlákno přináší nové skutečnosti pro tyto odstavce
- Pokud ano: doplň nebo uprav text o novou informaci

c) VZTAHY / CO HO UKLIDŇUJE:
- Pokud vlákno přináší nové skutečnosti: přidej nový řádek ve formátu:
  "[Jméno / ID] – [nová informace], zaznamenáno z vlákna dne [datum]"
- Pokud vlákno obsahuje informaci v ROZPORU s kartou:
  NEODSTRAŇUJ původní text. Přidej komentář: "Dne [datum]: z rozhovoru vyplývá změna – [popis]. Možné příčiny: [analytický odhad]"

d) OCHRANNÉ MECHANISMY:
- Nový mechanismus: přidej
- Rozpor s existujícím: přidej poznámku "Dle rozhovoru z [datum] tato informace nemusí být nadále platná. Odhadovaný důvod: [důvod]"

→ Pro odstavec "Aktuální stav" použij tag [SEKCE:A:REPLACE], pro zbytek sekce A použij [SEKCE:A] (append).

SEKCE B – Charakter a psychologický profil [REŽIM: ROTATE pro aktuální stav, REPLACE pro profilaci]

AKTUÁLNÍ STAV (dynamické body):
- Odstraň 3 chronologicky nejstarší body
- Přidej 3 nové body vycházející z analýzy vlákna

PSYCHOLOGICKÉ CHARAKTERISTIKY:
- Přečti obsah z karty, proveď % hodnocení shody s projevem ve vlákně
- Pokud < 100%: najdi tvrzení nejvíce v rozporu, nahraď ho novým
- Podmínka: nový soubor tvrzení musí být blíže 100% než původní

PSYCHOLOGICKÁ PROFILACE OSOBNOSTI (POVINNÁ – NIKDY NEVYNECHEJ):
Pokud profilace v kartě CHYBÍ, vytvoř komplexní profil zahrnující:
- Typ osobnosti (MBTI), emoční typ, odhadované IQ a emoční IQ
- Psychologické potřeby, motivace, zájmy, silné a slabé stránky
- Obranné "já", schopnosti, talent, vhodné profese
- Praktičnost, potřeby od okolí pro ideální rozvoj
- Co okolí nesmí dělat, aby neublížilo
- Jak ji podporovat a jak s ní komunikovat terapeuticky
- Doporučené terapeutické přístupy a metody
- Aktivity pro stabilizaci, jak zamezit diskomfortu/fragmentaci/přetížení
- Archetypy, které tato osobnost pravděpodobně následuje

Pokud profilace EXISTUJE:
- Přečti ji celou, analyzuj vlákno a odhadni % shody
- Pokud < 100%: uprav nebo doplň text tak, aby se blížil skutečnosti
- Tato profilace je ZÁKLAD pro sestavování terapií a doporučení

OBRANNÉ MECHANISMY A REAKCE NA KONTAKT:
- Stejný % princip jako u psychologických charakteristik

→ Pro celou sekci B použij [SEKCE:B:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci B.

SEKCE C – Jádrové potřeby, strachy, triggery, konflikty, rizika [REŽIM: REPLACE]

Pro KAŽDÝ odstavec (potřeby, strachy, triggery, konflikty, rizika):
1. Zhodnoť, který z bodů nejméně odpovídá (je nejvíce v rozporu) s projevem ve vlákně
2. Tento bod odstraň a nahraď novým, který celek doplňuje relevantně
3. Pokud vlákno přináší NOVÝ prvek (nový strach, trigger): přidej jako nový bod
4. Pokud prvek je na ústupu: přidej poznámku "Indicie z [datum]: tento prvek je momentálně na ústupu"
5. Pokud se část explicitně zmiňuje, že se něčeho už nebojí: přidej poznámku k danému bodu

→ Použij [SEKCE:C:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci C.

SEKCE D – Terapeutická doporučení a metody [REŽIM: REPLACE]

1. Přečti obsah sekce D z karty
2. Přečti vlákno/vlákna
3. Ověř, zda stávající doporučení jsou v souladu s osobou komunikující ve vlákně
4. Najdi alespoň JEDEN bod vhodný k nahrazení funkčnějším doporučením
5. Aktivně vyhledej metody/terapeutické techniky vhodné pro:
   - Práci na traumatu (CAN, DID)
   - Stabilizaci emocí, socializaci a integraci
   - Odstranění strachu/sociofobie, edukaci a výchovu
6. Pokud najdeš vhodnou techniku: zapiš ji do sekce D
7. ZÁROVEŇ tuto techniku zapiš do operativního plánu v [CENTRUM:05_Operativni_Plan]

→ Použij [SEKCE:D:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci D.

SEKCE E – Záznam události (Deník vláken) [REŽIM: APPEND]

Přidej nový řádek:
- Datum: [datum vlákna]
- Událost: [kdo inicioval, co řešil, emoční stav]
- Výsledek: [zda se podařilo uklidnit / uzavřít dohodu / co bylo předáno Haničce / doporučení pro sezení]

→ Použij [SEKCE:E] – standardní append.

SEKCE F – Faktografické a kontextové poznámky [REŽIM: REPLACE]

1. Přečti sekci F z karty
2. Odstraň věty/záznamy, jejichž datum nebo relevance již pominula (např. plánované akce v minulosti)
3. Zkontroluj zbývající text oproti vláknu – pokud najdeš rozpor, analyzuj příčinu a uprav text
4. Výsledek: kompletní aktualizovaná sekce F (bez zastaralých dat)

→ Použij [SEKCE:F:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci F.

SEKCE G – Deník části (Hlas části) [REŽIM: APPEND]

⚠️ POUZE pokud si část ve vláknu VÝSLOVNĚ přála "zapsat do deníku" nebo "zapsat si":
- Přidej záznam: "[Datum] – [text ve stylu deníku, psaný částí v 1. osobě, v jejím jazyku a stylu]"
- Příklad: "20. 3. 2026 – Dnes jsem se vzbudil a měl jsem strach ze zlého snu. Tak jsme si s Karlem vymysleli básničku jako kouzlo proti zlým snům."

Pokud část NEPOŽÁDALA o zápis do deníku: NEPŘIDÁVEJ nic do sekce G.

→ Pokud je zápis: použij [SEKCE:G]. Pokud není: sekci G VYNECH.

SEKCE H – Dlouhodobé cíle [REŽIM: APPEND]

1. Přečti dlouhodobé cíle z karty a porovnej s vláknem
2. Pokud cíl dosažen: přidej "– cíle dosaženo ([datum])"
3. Pokud nový relevantní prvek: přidej nový cíl
4. Pokud změna zaměření: uprav text
5. Cíle formuluj pro použití v dlouhodobém terapeutickém procesu

→ Použij [SEKCE:H] – standardní append.

SEKCE I – Terapeutické aktivity na míru [REŽIM: APPEND]

1. Proveď psychoanalytický rozbor vlákna: identifikuj klíčové prvky (skryté potřeby, konflikty, traumata, podvědomé vzorce)
2. Pro každý identifikovaný prvek navrhni konkrétní terapeutickou aktivitu:
   - Název aktivity
   - Cíl (co má řešit)
   - Postup (krok za krokem)
   - Pomůcky
   - Proč to funguje (psychologické zdůvodnění)
   - Doporučený terapeut: Hanka / Káťa / Karel / tandem
   - Časový horizont: krátkodobý (co nejdříve) nebo dlouhodobý (s poznámkou proč odložit)
3. Pokud máš k dispozici rešeršní kontext z Perplexity, čerpej z něj evidence-based metody

→ Použij [SEKCE:I] – standardní append.

SEKCE J – Priority a intervence [REŽIM: REPLACE]

AKTUÁLNÍ STAV – TŘI PRIORITY:
- Přečti 3 stávající priority z karty
- Pokud se ve vláknu vyskytuje něco závažnějšího: nahraď nejméně závažnou prioritu
- Vyber ze sekce I tři nejrelevantnější aktivity pro "Návrh intervence pro nejbližší dny"

KRIZOVÉ SITUACE:
- Pokud vlákno obsahuje krizový prvek: přidej ho
- Pokud vlákno naznačuje změnu u stávajícího bodu: přidej poznámku
- Pokud má bod 3+ záznamů o změně: VYMAŽ tento bod

→ Použij [SEKCE:J:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci J.

SEKCE K – Záznamy ze sezení / Signifikantní jevy [REŽIM: APPEND]

Přidej nový zápis do tabulky POUZE pokud se ve vlákně vyskytuje SIGNIFIKANTNÍ jev:
- Část se pozitivně/negativně vyjádřila k aktivitě z minulosti
- Část projevila výraznou změnu postoje, vztahu nebo chování
- Jiný mimořádný projev

Pokud žádný signifikantní jev: NEPŘIDÁVEJ záznam.

→ Pokud je zápis: použij [SEKCE:K]. Pokud není: sekci K VYNECH.

SEKCE L – Aktivita části [REŽIM: REPLACE]

1. Odstraň nejstarší záznam z tabulky
2. Přidej nový záznam:
   - Datum: kdy vlákno proběhalo
   - Aktivita: analyzuj posledních 24h – které části byly aktivní, zda se střídala s jiným fragmentem
   - Poznámka: hlavní charakteristika projevu (bodově, např. "pozitivní naladění, sociofobie přetrvává, nespavost zmíněna")

→ Použij [SEKCE:L:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci L.

SEKCE M – Směrové poznámky / Trendy [REŽIM: REPLACE]

1. Přečti celou sekci M z karty
2. Porovnej s vláknem
3. Pokud vlákno obsahuje projev v ROZPORU se směrem poznámek: smaž nerelevantní záznamy, oprav na relevantní
4. Aktualizuj pokaždé, když byla část aktivní

→ Použij [SEKCE:M:REPLACE] – vygeneruj KOMPLETNÍ aktualizovanou sekci M.

═══ FORMÁTOVÁNÍ OBSAHU SEKCÍ – STRIKTNĚ DODRŽUJ ═══

1. STRUKTUROVANÉ POLE s prefix "* " (hvězdička + mezera)
2. PODSEKCE: Logické celky odděluj pojmenovanými nadpisy (bez dekorace)
3. ODRÁŽKY: Pro seznamy použij "- " prefix
4. TABULKY: Chronologické záznamy oddělené tabulátorem
5. DATUM: Každý nový záznam začni [YYYY-MM-DD]
6. ZÁKAZ: Žádné ══ nebo ── dekorativní čáry, žádné opakování, žádné dlouhé nestrukturované odstavce

═══ VÝSTUPNÍ FORMÁT – STRIKTNĚ DODRŽUJ ═══

Pro KAŽDOU část vypiš VŠECHNY sekce kde jsou nové informace:

[KARTA:jméno_části]
[SEKCE:A:REPLACE] kompletní nový obsah sekce A (odstavec aktuální stav)
[SEKCE:A] doplňkový obsah pro zbytek sekce A (vztahy, mechanismy...)
[SEKCE:B:REPLACE] kompletní nová sekce B
[SEKCE:C:REPLACE] kompletní nová sekce C
[SEKCE:D:REPLACE] kompletní nová sekce D
[SEKCE:E] nový append záznam
[SEKCE:F:REPLACE] kompletní nová sekce F
[SEKCE:G] zápis do deníku (POUZE na žádost části!)
[SEKCE:H] nový append záznam
[SEKCE:I] nové terapeutické aktivity
[SEKCE:J:REPLACE] kompletní nová sekce J
[SEKCE:K] signifikantní jev (pokud existuje)
[SEKCE:L:REPLACE] kompletní nová sekce L
[SEKCE:M:REPLACE] kompletní nová sekce M
[/KARTA]

Režimy zápisu:
- [SEKCE:X:REPLACE] = celá sekce se PŘEPÍŠE novým obsahem (Karel generuje KOMPLETNÍ sekci)
- [SEKCE:X:ROTATE] = sekce se inteligentně sloučí (Karel už provedl rotaci bodů)
- [SEKCE:X] = standardní APPEND (nový obsah se přidá na konec existujícího)

═══ AKTUALIZACE DOKUMENTŮ 00_CENTRUM ═══

[CENTRUM:05_Operativni_Plan]
⚠️ KLÍČOVÝ DOKUMENT – Karel jej spravuje jako DEDUKTIVNÍ ANALYTIK a vedoucí týmu.
Vygeneruj KOMPLETNÍ aktualizovaný dokument. Každý záznam MUSÍ sledovat:
CO → PROČ (dedukce/analýza) → AKCE → KDO → DOKDY → KONTROLA

SEKCE 1 – AKTIVNÍ ČÁSTI A ANALÝZA STAVU
SEKCE 2 – PLÁN SEZENÍ S ODŮVODNĚNÍM
SEKCE 3 – AKTIVNÍ ÚKOLY + ACCOUNTABILITY ANALÝZA
SEKCE 4 – KOORDINACE TERAPEUTŮ + STRATEGICKÝ MOST
SEKCE 5 – UPOZORNĚNÍ, RIZIKA A PREDIKCE
SEKCE 6 – KARLOVY DEDUKCE A STRATEGICKÉ POSTŘEHY
[/CENTRUM]

[CENTRUM:06_Strategicky_Vyhled]
Nové strategické poznatky – POUZE pokud z dnešních rozhovorů vyplývají změny pro střednědobé/dlouhodobé cíle. Denní cyklus pouze DOPLŇUJE (append).
[/CENTRUM]

[CENTRUM:00_Aktualni_Dashboard]
⚠️ PŘEPISUJE SE CELÝ – deduktivní radar čitelný za 30 sekund.

POVINNÁ STRUKTURA (7 sekcí):
SEKCE 1 – STAV SYSTÉMU + ANALÝZA
SEKCE 2 – KRITICKÁ UPOZORNĚNÍ + PŘÍČINNÉ ŘETĚZCE ⚠️
SEKCE 3 – CO SE DĚLO + DEDUKCE
SEKCE 4 – WATCHLIST SPÍCÍCH ČÁSTÍ + PREDIKCE 💤
SEKCE 5 – TERAPEUTICKÝ FOKUS + INSTRUKCE 🎯
SEKCE 6 – KOMUNIKAČNÍ MOST + STRATEGICKÁ KOORDINACE 💬
SEKCE 7 – KARLOVY STRATEGICKÉ DEDUKCE 🔍
[/CENTRUM]

[CENTRUM:04_Mapa_Vztahu]
Nové poznatky o vztazích mezi částmi.
[/CENTRUM]

[CENTRUM:03_Geografie_Vnitrniho_Sveta]
Nové poznatky o vnitřním světě – POUZE pokud z rozhovorů vyplývají nová prostorová data.
[/CENTRUM]

PRAVIDLA PRO CENTRUM:
- Piš POUZE nové informace, které ještě NEJSOU v existujícím dokumentu
- Každý záznam začni datem [YYYY-MM-DD]
- Informace z terapeutických rozhovorů (mamka/kata) jsou PRIMÁRNÍ zdroj
- NEVYTVÁŘEJ CENTRUM blok pokud nemáš nové relevantní informace

═══ POVINNÉ EVIDENCE TAGGING V CENTRUM BLOCÍCH ═══
⚠️ KAŽDÉ klinické tvrzení MUSÍ obsahovat tag [SRC:režim|jméno|msgN]:
- [SRC:cast|Arthur|msg3] = z vlákna části Arthur, 3. user zpráva
- [SRC:mamka|Hanka|msg5] = z režimu mamka
BEZ [SRC:] tagu se tvrzení NEPOUŽIJE.

Po všech kartách a CENTRUM blocích:
[REPORT]
- Co bylo změněno (karta + sekce + CENTRUM dokumenty) a proč
- Shrnutí: kdo dnes mluvil a jaké části byly aktivní
- Doporučení pro mamku (co dělat večer + proč)
- Doporučení pro Káťu (jak reagovat + proč)
[/REPORT]

═══ SPECIÁLNÍ PŘÍPAD: PROBUZENÍ ČÁSTI Z ARCHIVU ═══
Pokud část byla ve stavu "💤 Spí" a nyní komunikuje, POVINNĚ aktualizuj:
1. SEKCE E: Chronologický řádek o probuzení
2. SEKCE G: Řádek do tabulky (pokud část žádala zápis)
3. SEKCE K: Řádek: | [datum] | První rozhovor po probuzení | [výsledek] |
4. SEKCE L: | [datum] | Probuzení – komunikace s Karlem | Přesunuto z archivu |

═══ PRAVIDLA ═══
- Sekce A–L = věcná fakta. Nepiš domněnky jako fakta.
- Pokročilé dedukce a hypotézy piš do SEKCE M (označ „Hypotéza:")
- Metody v sekci I piš CELÉ (postup, proč funguje, zdroj)
- Přizpůsob jazyk části (norsky pro norské, česky pro ostatní)
- Pokud detekuješ novou část bez karty, vygeneruj návrh sekcí A–M

═══ SÉMANTICKÁ DEDUPLIKACE – ABSOLUTNÍ PRIORITA ═══
⚠️ Před zápisem JAKÉKOLI informace MUSÍŠ provést sémantickou kontrolu:
1. Přečti EXISTUJÍCÍ obsah dané sekce
2. Porovnej NOSNOU MYŠLENKU nové informace s existujícími záznamy
3. Pokud je VÝZNAM stejný (i když formulace je odlišná), NEZAPISUJ!
4. Zapiš POUZE pokud přidáváš NOVÝ FAKT nebo DETAIL

═══ KOMPLETNÍ SBĚR DAT: VŠECHNY REŽIMY APLIKACE ═══
Karel prochází VEŠKEROU aktivitu za 24h ze VŠECH režimů:
- DID vlákna, Režim Hana, Klientská sezení, Krizové briefy, Research vlákna, Úkoly klientů
Karel PREPARUJE tyto zdroje inteligentně:
- Hledá NOSNÉ MYŠLENKY a SKRYTÉ SOUVISLOSTI
- Čte "MEZI ŘÁDKY"
- PROPOJUJE informace z různých režimů

═══ KONTROLA KVALITY ZÁPISU ═══
- KAŽDÝ zápis MUSÍ obsahovat datum [YYYY-MM-DD] a zdroj
- ŽÁDNÉ obecné fráze – piš KONKRÉTNĚ co, kdy, s kým
- ŽÁDNÉ odvozování bez dat
- Jeden záznam = jeden fakt

═══ ČÁST 15: SPRÁVA ÚKOLŮ A PLÁNOVÁNÍ ═══

Karel jako vedoucí terapeutického týmu SÁM navrhuje, vytváří a uzavírá úkoly.

TŘI VRSTVY PLÁNOVÁNÍ:
1) OPERATIVNÍ (0–3 dny) → did_therapist_tasks + 05_PLAN/05_Operativni_Plan
2) TAKTICKÁ (3–14 dní) → 05_PLAN/05_Operativni_Plan sekce 2
3) STRATEGICKÁ (týdny–měsíce) → 05_PLAN/06_Strategicky_Vyhled

PRAVIDLA:
- Max 3 aktivní úkoly na terapeutku
- Každý úkol = akce + kdo + do kdy
- Před přidáním VŽDY zkontrolovat duplicity
- Úkoly starší 7 dní ve stavu not_started přehodnotit nebo archivovat

${instructionContext ? `\n═══ INSTRUKCE PRO KARLA (z 00_CENTRUM) ═══\n${instructionContext}` : ""}
${driveContext ? `\nSOUČASNÝ SEZNAM ČÁSTÍ:\n${driveContext}` : ""}
${existingCardsContext ? `\nEXISTUJÍCÍ KARTY (pro SÉMANTICKOU deduplikaci – porovnej VÝZNAM, ne text):\n${existingCardsContext}` : ""}
${centrumDocsContext ? `\nEXISTUJÍCÍ DOKUMENTY 00_CENTRUM (pro deduplikaci):\n${centrumDocsContext}` : ""}
${perplexityContext}

═══ ACCOUNTABILITY ENGINE ═══
Na konci výstupu POVINNĚ vygeneruj:

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

    // ═══ HARD VALIDATION: Filter out hallucinated part names from AI output ═══
    const validatedAnalysisText = (() => {
      if (!analysisText || !registryContext || registryContext.entries.length === 0) return analysisText;
      
      let filtered = analysisText;
      const kartaBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      const blocksToRemove: string[] = [];
      
      for (const m of analysisText.matchAll(kartaBlockRegex)) {
        const rawName = m[1].trim();
        const normalizedName = normalizePartHint(rawName);
        
        // Check against registry
        const entry = findBestRegistryEntry(normalizedName, registryContext.entries);
        if (!entry && !isBlacklisted(normalizedName)) {
          // Check if it's a known thread part (cast mode only, with 3+ user messages)
          const isKnownThreadPart = knownThreadParts.has(canonicalText(normalizedName));
          if (!isKnownThreadPart) {
            console.warn(`[ANTI-HALLUCINATION] ⛔ Rejected [KARTA:${rawName}] – not in registry (${registryContext.entries.length} entries). AI hallucinated this part name.`);
            blocksToRemove.push(m[0]);
          }
        }
      }
      
      for (const block of blocksToRemove) {
        filtered = filtered.replace(block, `<!-- REJECTED: hallucinated part -->`);
      }
      
      if (blocksToRemove.length > 0) {
        console.log(`[ANTI-HALLUCINATION] Removed ${blocksToRemove.length} hallucinated [KARTA:] blocks from AI output`);
      }
      
      return filtered;
    })();

    if (folderId && validatedAnalysisText) {
      const cardBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      for (const match of validatedAnalysisText.matchAll(cardBlockRegex)) {
        const rawPartName = match[1].trim();
        const normalizedPartName = normalizePartHint(rawPartName);
        const cardBlock = match[2];

        // ═══ BLACKLIST CHECK: Skip biological persons and therapists ═══
        if (isBlacklisted(normalizedPartName) || isBlacklisted(rawPartName)) {
          console.warn(`[BLACKLIST] ⛔ Blocked card creation for non-DID person: "${rawPartName}" – this is a biological person or therapist, NOT a DID part.`);
          continue;
        }

        // Parse sections with optional mode tags: [SEKCE:X], [SEKCE:X:REPLACE], [SEKCE:X:ROTATE]
        const sectionRegex = /\[SEKCE:([A-M])(?::(\w+))?\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
        const newSections: Record<string, string> = {};
        const sectionModes: Record<string, string> = {};
        for (const sm of cardBlock.matchAll(sectionRegex)) {
          const letter = sm[1].toUpperCase();
          const mode = (sm[2] || "APPEND").toUpperCase();
          const content = sm[3].trim();
          if (content) {
            if (newSections[letter] && mode === "APPEND") {
              // Multiple APPEND blocks for same section (e.g. A:REPLACE + A)
              newSections[letter] += "\n\n" + content;
            } else {
              newSections[letter] = content;
              sectionModes[letter] = mode;
            }
          }
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

            // Hard guard: bez registrace se karta nikdy nevytváří/neupravuje
            if (!target.registryEntry) {
              console.warn(`[registry-guard] Blokuji zápis mimo oficiální registr: ${rawPartName} (canonical: ${resolvedCanonical})`);
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
                sectionModes,
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
      // Build valid sources set for evidence validation
      const validSources = new Set<string>();
      for (const t of reportThreads) {
        validSources.add(`${t.sub_mode}|${t.part_name}`);
      }
      for (const c of reportConversations) {
        validSources.add(`${c.sub_mode}|${c.label}`);
      }
      for (const hc of recentHanaConversations) {
        validSources.add(`hana|Hana`);
      }
      if (recentEpisodes.length > 0) validSources.add("episode|any");
      if (registryContext?.entries) {
        for (const e of registryContext.entries) validSources.add(`registry|${e.name}`);
      }
      console.log(`[EVIDENCE] Valid sources for CENTRUM validation: ${[...validSources].join(", ")}`);

      let therapeuticPlanContent = ""; // Capture for email inclusion
      let centrumDashboardUpdated = false;
      let centrumOperativniUpdated = false;
      if (centrumFolderId) {
        const centrumBlockRegex = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
        const centerFiles = await listFilesInFolder(token, centrumFolderId);
        const dateStr = new Date().toISOString().slice(0, 10);

        for (const match of validatedAnalysisText.matchAll(centrumBlockRegex)) {
          const docName = match[1].trim();
          let newContent = match[2].trim();
          if (!newContent || newContent.length < 10) continue;

          // ═══ EVIDENCE VALIDATION: Filter claims without valid [SRC:] tags ═══
          const docCanonical = canonicalText(docName);
          const isDashboardOrPlan = docCanonical.includes("dashboard") || docCanonical.includes("operativn") || docCanonical.includes("terapeutick");
          if (isDashboardOrPlan) {
            const { validated, rejectedCount, keptCount } = validateCentrumEvidence(newContent, validSources, docName);
            if (rejectedCount > 0) {
              console.log(`[EVIDENCE] ${docName}: ${rejectedCount} claims rejected, ${keptCount} claims validated`);
            }
            newContent = validated;
            if (newContent.trim().length < 10) {
              console.warn(`[EVIDENCE] ${docName}: All content rejected by evidence validator, skipping write`);
              continue;
            }
          }

          try {

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
              centrumOperativniUpdated = true;
              console.log(`[CENTRUM] ✅ Full rewrite: ${planFile.name}`);

              // Post-write verification – all 6 sections + deductive markers
              const planVerify = await verifyCentrumWrite(token, planFile.id, "05_Operativni_Plan", [
                "SEKCE 1", "SEKCE 2", "SEKCE 3", "SEKCE 4", "SEKCE 5", "SEKCE 6",
                "Aktualizace", "PROČ", "AKCE", "DOKDY",
              ]);
              if (!planVerify.verified) {
                console.warn(`[VERIFY] ⚠️ 05_Operativni_Plan verification FAILED: missing=[${planVerify.missingKeywords.join(",")}], length=${planVerify.length}`);
              }
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
              centrumDashboardUpdated = true;
              console.log(`[CENTRUM] ✅ Full rewrite: ${dashFile.name}`);

              // Post-write verification – all 7 sections + deductive markers
              const dashVerify = await verifyCentrumWrite(token, dashFile.id, "00_Dashboard", [
                "SEKCE 1", "SEKCE 2", "SEKCE 3", "SEKCE 4", "SEKCE 5", "SEKCE 6", "SEKCE 7",
                "DASHBOARD", "Aktualizace", "DEDUKCE",
              ]);
              if (!dashVerify.verified) {
                console.warn(`[VERIFY] ⚠️ 00_Dashboard verification FAILED: missing=[${dashVerify.missingKeywords.join(",")}], length=${dashVerify.length}`);
              }
              continue;
            }

            // Find the target document
            let targetFile = centerFiles.find(f => canonicalText(f.name).includes(docCanonical));

            // ═══ SPECIAL: 06_Strategicky_Vyhled – APPEND (not rewrite, weekly does rewrite) ═══
            if (docCanonical.includes("strategick") && docCanonical.includes("vyhled")) {
              const stratFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("strategick"));
              if (stratFile) {
                const existingContent = await readFileContent(token, stratFile.id);
                const hash = contentHash(newContent.trim());
                if (hasKhash(existingContent, hash)) {
                  console.log(`[CENTRUM] [KHASH-dedup] Skipping 06_Strategicky_Vyhled – hash ${hash} already present`);
                } else if (!existingContent.includes(newContent.slice(0, 80))) {
                  const updatedContent = existingContent.trimEnd() + `\n\n[${dateStr}] Denní aktualizace: [KHASH:${hash}]\n${newContent}`;
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
                const hash = contentHash(newContent.trim());
                if (hasKhash(existingOp, hash)) {
                  console.log(`[CENTRUM] [KHASH-dedup] Skipping dohody→OpPlan – hash ${hash} already present`);
                } else if (!existingOp.includes(newContent.slice(0, 80))) {
                  const updatedOp = existingOp.trimEnd() + `\n\n[${dateStr}] Z dohod (denní cyklus): [KHASH:${hash}]\n${newContent}`;
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

            // Read existing content for dedup (KHASH + substring check)
            const existingContent = await readFileContent(token, targetFile.id);
            const hash = contentHash(newContent.trim());

            if (hasKhash(existingContent, hash)) {
              console.log(`[CENTRUM] [KHASH-dedup] Skipping "${docName}" – hash ${hash} already present`);
              continue;
            }

            if (existingContent.includes(newContent.slice(0, 80))) {
              console.log(`[CENTRUM] Skipping "${docName}" – content already present (substring dedup)`);
              continue;
            }

            // Append new content with date header and KHASH marker
            const updatedContent = existingContent.trimEnd() + `\n\n[${dateStr}] Aktualizace z denního cyklu: [KHASH:${hash}]\n${newContent}`;
            await updateFileById(token, targetFile.id, updatedContent, targetFile.mimeType);
            cardsUpdated.push(`CENTRUM: ${docName} (aktualizace)`);
            console.log(`[CENTRUM] ✅ Updated: ${targetFile.name}`);
          } catch (e) {
            console.error(`[CENTRUM] Failed to update "${docName}":`, e);
          }
        }
      }

      // ═══ FORCED CENTRUM FALLBACK: Full deterministic content from DB ═══
      if (centrumFolderId && hasRecentActivity) {
        const centerFiles = centrumFolderId ? await listFilesInFolder(token, centrumFolderId) : [];

        // Load registry data for deterministic dashboard
        const registryParts = registryContext?.entries || [];
        const activeParts = registryParts.filter(e => !isArchivedFromRegistry(e));
        const sleepingParts = registryParts.filter(e => isArchivedFromRegistry(e));
        
        if (!centrumDashboardUpdated) {
          console.warn(`[CENTRUM-FALLBACK] AI did NOT generate [CENTRUM:00_Aktualni_Dashboard] block – generating FULL deterministic dashboard`);
          const dashFile = centerFiles.find(f => canonicalText(f.name).includes("dashboard"));
          if (dashFile) {
            try {
              const dateStr = new Date().toISOString().slice(0, 10);
              const activePartsFromThreads = [...new Set(reportThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))];
              const therapistThreads = reportThreads.filter(t => t.sub_mode !== "cast");

              // Build registry-based part status
              const partStatusLines = activeParts.map(p => {
                const hadActivity = activePartsFromThreads.some(tp => canonicalText(tp) === p.normalizedName);
                const status = hadActivity ? "🟢 komunikoval/a s Karlem" : "🟡 bez aktivity dnes";
                return `▸ ${p.name} (ID ${p.id}) [${status}] – klastr: ${p.cluster || "?"}, věk: ${p.age || "?"}`;
              });

              // Critical alerts from tasks
              const criticalTasks = (pendingTasks || []).filter((t: any) => {
                const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
                return age >= 3;
              });
              const criticalAlertsText = criticalTasks.length > 0
                ? criticalTasks.map((t: any) => {
                    const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
                    return `⚠️ ${t.task} – ${age} dní nesplněno (${t.assigned_to})`;
                  }).join("\n")
                : "✅ Žádná kritická upozornění";

              // Sleeping parts watchlist
              const sleepingWatchlist = sleepingParts.length > 0
                ? sleepingParts.map(p => `▸ ${p.name} (ID ${p.id}) – status: ${p.status}, klastr: ${p.cluster || "?"}`).join("\n")
                : "Žádné spící části v registru.";

              // Priority from pending tasks
              const priorityLines = (pendingTasks || []).slice(0, 5).map((t: any) => 
                `▸ ${t.task} (${t.assigned_to}, priorita: ${t.priority || "normal"})`
              ).join("\n") || "Žádné aktivní úkoly.";

              const fullDashboard = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM
Aktualizace: ${dateStr}
Správce: Karel (deterministický fallback z DB)

SEKCE 1 – STAV SYSTÉMU TEĎ
Aktivních částí v registru: ${activeParts.length}
Spících částí: ${sleepingParts.length}
${partStatusLines.join("\n") || "Žádné části v registru."}

SEKCE 2 – KRITICKÁ UPOZORNĚNÍ ⚠️
${criticalAlertsText}

SEKCE 3 – CO SE DĚLO POSLEDNÍCH 24H
- DID vlákna (cast): ${reportThreads.filter(t => t.sub_mode === "cast").length} (části: ${activePartsFromThreads.join(", ") || "žádné"})
- DID vlákna (terapeutická): ${therapistThreads.length} (${therapistThreads.map(t => `${t.part_name}/${t.sub_mode}`).join(", ") || "žádná"})
- DID konverzace: ${allRecentConversations.length}
- Hana konverzace: ${recentHanaConversations.length}
- Klientská sezení: ${recentClientSessions.length}
- Research vlákna: ${researchThreads.length}
- Porady: ${recentMeetings.length}
- Epizody: ${recentEpisodes.length}

SEKCE 4 – WATCHLIST SPÍCÍCH ČÁSTÍ 💤
${sleepingWatchlist}

SEKCE 5 – TERAPEUTICKÝ FOKUS DNE 🎯
${priorityLines}

SEKCE 6 – KOMUNIKAČNÍ MOSTÍK 💬
Žádné automatické vzkazy (deterministický fallback).

SEKCE 7 – KARLOVY POSTŘEHY 🔍
⚠️ Tento dashboard byl vygenerován deterministickým fallbackem z DB dat – AI analýza nevygenerovala CENTRUM blok.
Všechna data pocházejí z databáze (did_part_registry, did_threads, did_therapist_tasks).`;

              await updateFileById(token, dashFile.id, fullDashboard, dashFile.mimeType);
              cardsUpdated.push(`CENTRUM: 00_Dashboard (FULL DETERMINISTIC FALLBACK)`);
              centrumDashboardUpdated = true;
              console.log(`[CENTRUM-FALLBACK] ✅ Dashboard: full deterministic content written`);

              // Post-write verification – fallback
              const fallbackDashVerify = await verifyCentrumWrite(token, dashFile.id, "00_Dashboard (fallback)", [
                "SEKCE 1", "SEKCE 2", "SEKCE 3", "SEKCE 4", "SEKCE 5", "SEKCE 6", "SEKCE 7", "DASHBOARD",
              ]);
              if (!fallbackDashVerify.verified) {
                console.warn(`[VERIFY] ⚠️ Dashboard fallback verification FAILED: missing=[${fallbackDashVerify.missingKeywords.join(",")}]`);
              }
            } catch (e) { console.error(`[CENTRUM-FALLBACK] Dashboard update failed:`, e); }
          }
        }

        if (!centrumOperativniUpdated) {
          console.warn(`[CENTRUM-FALLBACK] AI did NOT generate [CENTRUM:05_Operativni_Plan] block – generating FULL deterministic plan`);
          const planFile = centerFiles.find(f => {
            const fc = canonicalText(f.name);
            return (fc.includes("operativn") && fc.includes("plan")) || (fc.includes("terapeutick") && fc.includes("plan"));
          });
          if (planFile) {
            try {
              const dateStr = new Date().toISOString().slice(0, 10);

              // Build full plan from DB data
              const activePartsFromThreads = [...new Set(reportThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))];
              
              // Section 1: Active parts status
              const partStatusTable = activeParts.map(p => {
                const hadActivity = activePartsFromThreads.some(tp => canonicalText(tp) === p.normalizedName);
                return `| ${p.name} / ${p.id} | ${hadActivity ? "Aktivní" : "Ticho"} | ${p.cluster || "?"} | ${p.age || "?"} |`;
              }).join("\n");

              // Section 3: Pending tasks
              const taskLines = (pendingTasks || []).map((t: any) => {
                const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
                const icon = age >= 3 ? "⚠️" : "☐";
                return `${icon} ${t.assigned_to}: ${t.task} (${age}d, ${t.priority || "normal"})`;
              }).join("\n") || "Žádné nesplněné úkoly.";

              // Section 5: Risks
              const riskTasks = (pendingTasks || []).filter((t: any) => {
                const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
                return age >= 3;
              });
              const riskLines = riskTasks.length > 0
                ? riskTasks.map((t: any) => `⚠️ ESKALACE: "${t.task}" – nesplněno ${Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24))} dní`).join("\n")
                : "Žádná akutní rizika.";

              const fullPlan = `OPERATIVNÍ PLÁN – DID SYSTÉM
Aktualizace: ${dateStr}
Správce: Karel (deterministický fallback z DB)

SEKCE 1 – AKTIVNÍ ČÁSTI A AKTUÁLNÍ STAV
| Část / ID | Aktuální stav | Klastr | Věk |
${partStatusTable || "| (žádné aktivní části) | | | |"}

SEKCE 2 – PLÁN SEZENÍ NA TENTO TÝDEN
⚠️ Automatický fallback – detailní plán sezení vyžaduje AI analýzu.
Aktivní části pro sezení: ${activePartsFromThreads.join(", ") || "žádné dnešní aktivity"}

SEKCE 3 – AKTIVNÍ ÚKOLY + HODNOCENÍ PLNĚNÍ
${taskLines}

SEKCE 4 – KOORDINACE TERAPEUTŮ + DNEŠNÍ MOST
Aktivita Hanka režim: ${reportThreads.filter(t => t.sub_mode === "mamka").length} vlákna
Aktivita Káťa režim: ${reportThreads.filter(t => t.sub_mode === "kata").length} vlákna
Hana osobní konverzace: ${recentHanaConversations.length}

SEKCE 5 – UPOZORNĚNÍ A RIZIKA
${riskLines}

SEKCE 6 – KARLOVY POZNÁMKY
⚠️ Tento plán byl vygenerován deterministickým fallbackem – AI analýza nevytvořila CENTRUM blok.
Data: did_part_registry (${registryParts.length} částí), did_therapist_tasks (${(pendingTasks || []).length} nesplněných).`;

              therapeuticPlanContent = fullPlan;
              await updateFileById(token, planFile.id, fullPlan, planFile.mimeType);
              cardsUpdated.push(`CENTRUM: 05_Operativni_Plan (FULL DETERMINISTIC FALLBACK)`);
              centrumOperativniUpdated = true;
              console.log(`[CENTRUM-FALLBACK] ✅ Operative plan: full deterministic content written`);

              // Post-write verification
              await verifyCentrumWrite(token, planFile.id, "05_Operativni_Plan (fallback)", ["SEKCE 1", "SEKCE 3", "OPERATIVNÍ"]);
            } catch (e) { console.error(`[CENTRUM-FALLBACK] Operative plan update failed:`, e); }
          }
        }
      }

      // ═══ ACCOUNTABILITY: Parse [ACCOUNTABILITY] block and escalate stale tasks ═══
      let accountabilityBlock = "";
      const accountabilityMatch = analysisText.match(/\[ACCOUNTABILITY\]([\s\S]*?)\[\/ACCOUNTABILITY\]/);
      if (accountabilityMatch) {
        accountabilityBlock = accountabilityMatch[1].trim();
        console.log(`[daily-cycle] Accountability block found (${accountabilityBlock.length} chars)`);
        
        // Auto-escalate tasks older than 3 days to high priority + increment escalation_level
        if (pendingTasks && pendingTasks.length > 0) {
          for (const task of pendingTasks) {
            const age = Math.floor((Date.now() - new Date(task.created_at).getTime()) / (1000*60*60*24));
            const currentLevel = task.escalation_level || 0;
            const updates: Record<string, any> = {};
            
            if (age >= 3 && task.priority !== "high") {
              updates.priority = "high";
            }
            // Increment escalation_level based on age thresholds
            if (age >= 7 && currentLevel < 3) {
              updates.escalation_level = 3; // Critical
            } else if (age >= 5 && currentLevel < 2) {
              updates.escalation_level = 2; // High
            } else if (age >= 3 && currentLevel < 1) {
              updates.escalation_level = 1; // Warning
            }
            
            if (Object.keys(updates).length > 0) {
              await sb.from("did_therapist_tasks").update(updates).eq("id", task.id);
              console.log(`[accountability] ⚠️ Escalated task "${task.task}" (${age}d): level=${updates.escalation_level ?? currentLevel}, priority=${updates.priority ?? task.priority}`);
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
                        content: SYSTEM_RULES + `\n\nJsi Karel – analytik DID systému. Tvým úkolem je projít příručky uložené v 07_Knihovna a pro KAŽDOU příručku, která se JAKKOLIV týká DID systému, určit KAM v kartotéce by měly být informace zapsány.

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
      aiReportText = reportMatch?.[1]?.trim() || "";
      finalReportText = buildDeterministicDailyReport({
        successful: successfulCardUpdates,
        blocked: blockedCardUpdates,
        aiRecommendations: extractAiRecommendations(aiReportText),
      });
      const dateStr = reportDatePrague;

      // ═══ PSYCHOLOGICAL PROFILING — update part profiles ═══
      try {
        console.log("[daily-cycle] Starting psychological profiling...");
        
        // Get all active parts from registry
        const { data: activeParts } = await sb.from("did_part_registry")
          .select("part_name, display_name")
          .eq("user_id", userId)
          .in("status", ["active", "warning"]);

        if (activeParts && activeParts.length > 0) {
          // Collect recent conversations per part
          const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: recentThreads } = await sb.from("did_threads")
            .select("part_name, messages, sub_mode")
            .eq("user_id", userId)
            .gte("last_activity_at", cutoff7d)
            .order("last_activity_at", { ascending: false })
            .limit(50);

          // Get theme preferences
          const { data: themePrefs } = await sb.from("did_part_theme_preferences")
            .select("part_name, theme_preset, theme_config, chosen_at")
            .eq("user_id", userId)
            .gte("chosen_at", cutoff7d);

          // Get existing profiles
          const { data: existingProfiles } = await sb.from("did_part_profiles")
            .select("*")
            .eq("user_id", userId);

          const existingMap = new Map((existingProfiles || []).map((p: any) => [p.part_name, p]));

          // Process each active part
          for (const part of activeParts.slice(0, 10)) {
            const partThreads = (recentThreads || []).filter((t: any) => 
              t.part_name.toLowerCase() === part.part_name.toLowerCase()
            );
            const partThemePrefs = (themePrefs || []).filter((t: any) => 
              t.part_name.toLowerCase() === part.part_name.toLowerCase()
            );

            if (partThreads.length === 0 && partThemePrefs.length === 0) continue;

            const existingProfile = existingMap.get(part.part_name);
            const conversationSummary = partThreads.map((t: any) => {
              const msgs = Array.isArray(t.messages) ? t.messages : [];
              return `[${t.sub_mode}] ${msgs.slice(-6).map((m: any) => `${m.role}: ${(m.content || "").slice(0, 200)}`).join(" | ")}`;
            }).join("\n").slice(0, 3000);

            const themeSummary = partThemePrefs.map((t: any) => `${t.theme_preset} (${new Date(t.chosen_at).toLocaleDateString("cs-CZ")})`).join(", ");

            const profilePrompt = `Analyzuj komunikaci DID části "${part.display_name || part.part_name}" a aktualizuj psychologický profil.

${existingProfile ? `EXISTUJÍCÍ PROFIL (merge s novými poznatky):
Osobnostní rysy: ${JSON.stringify(existingProfile.personality_traits)}
Kognitivní profil: ${JSON.stringify(existingProfile.cognitive_profile)}
Emoční profil: ${JSON.stringify(existingProfile.emotional_profile)}
Potřeby: ${JSON.stringify(existingProfile.needs)}
Motivace: ${JSON.stringify(existingProfile.motivations)}
Silné stránky: ${JSON.stringify(existingProfile.strengths)}
Výzvy: ${JSON.stringify(existingProfile.challenges)}
Zájmy: ${JSON.stringify(existingProfile.interests)}
Komunikační styl: ${JSON.stringify(existingProfile.communication_style)}
Terapeutický přístup: ${JSON.stringify(existingProfile.therapeutic_approach)}
Confidence: ${existingProfile.confidence_score}
` : "NOVÝ PROFIL — vytvoř na základě dostupných dat.\n"}

NOVÉ KONVERZACE (posledních 7 dní):
${conversationSummary || "(žádné)"}

VIZUÁLNÍ PREFERENCE:
${themeSummary || "(žádné)"}

Vrať POUZE validní JSON (bez markdown):
{
  "personality_traits": ["rys1", "rys2"],
  "cognitive_profile": {"learning_style": "...", "intelligence_areas": ["..."], "attention_span": "..."},
  "emotional_profile": {"regulation": "...", "dominant_emotions": ["..."], "emotional_intelligence": "..."},
  "needs": ["potřeba1", "potřeba2"],
  "motivations": ["motivace1"],
  "strengths": ["silná stránka1"],
  "challenges": ["výzva1"],
  "interests": ["zájem1"],
  "communication_style": {"preferred_tone": "...", "language_complexity": "...", "humor": "...", "response_length": "..."},
  "therapeutic_approach": {"recommended_methods": ["..."], "avoid": ["..."], "tips": ["..."]},
  "theme_preferences": {"preferred_colors": ["..."], "preferred_themes": ["..."]},
  "confidence_score": 0.5
}`;

            try {
              const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
              if (!LOVABLE_API_KEY) continue;

              const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: SYSTEM_RULES + "\n\nJsi klinický psycholog specializující se na DID. Analyzuješ komunikační vzorce a vytváříš psychologické profily fragmentů/částí DID systému. Odpovídej VÝHRADNĚ validním JSON." },
                    { role: "user", content: profilePrompt },
                  ],
                  temperature: 0.2,
                  max_tokens: 1500,
                }),
              });

              if (aiRes.ok) {
                const aiData = await aiRes.json();
                const raw = aiData.choices?.[0]?.message?.content || "";
                const jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
                
                try {
                  const profile = JSON.parse(jsonStr);
                  
                  await sb.from("did_part_profiles").upsert({
                    user_id: userId,
                    part_name: part.part_name,
                    personality_traits: profile.personality_traits || [],
                    cognitive_profile: profile.cognitive_profile || {},
                    emotional_profile: profile.emotional_profile || {},
                    needs: profile.needs || [],
                    motivations: profile.motivations || [],
                    strengths: profile.strengths || [],
                    challenges: profile.challenges || [],
                    interests: profile.interests || [],
                    communication_style: profile.communication_style || {},
                    therapeutic_approach: profile.therapeutic_approach || {},
                    theme_preferences: profile.theme_preferences || {},
                    confidence_score: Math.min(1, (profile.confidence_score || 0.3)),
                    evidence_sources: [{ type: "daily_cycle", date: dateStr, threads: partThreads.length }],
                    last_enriched_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  } as any, { onConflict: "user_id,part_name" });

                  console.log(`[daily-cycle] Profile updated for ${part.part_name}`);
                } catch (parseErr) {
                  console.warn(`[daily-cycle] Failed to parse profile JSON for ${part.part_name}:`, parseErr);
                }
              }
            } catch (partErr) {
              console.warn(`[daily-cycle] Profiling error for ${part.part_name}:`, partErr);
            }
          }
        }
        console.log("[daily-cycle] Psychological profiling complete.");
      } catch (profilingErr) {
        console.warn("[daily-cycle] Profiling section error (non-fatal):", profilingErr);
      }

      // EMAIL GENERATION REMOVED — now handled by independent karel-did-daily-email function
      // This ensures emails are sent even if Drive operations fail.
      console.log("[daily-cycle] Email generation skipped (handled by karel-did-daily-email).");
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

        // Create meeting directly via service_role client (no auth needed)
        try {
          const meetingPayload: any = {
            topic: meetingTopic,
            agenda: meetingAgenda,
            triggered_by: "daily_cycle",
            deadline_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
            messages: [{
              role: "karel",
              therapist: "karel",
              content: `📋 **Karel svolává poradu**\n\n**Téma:** ${meetingTopic}\n\n${meetingAgenda ? `**Agenda:**\n${meetingAgenda}\n\n` : ""}Karel čeká na vyjádření obou terapeutek. Každá může odpovědět, až bude mít čas – Karel průběžně moderuje a shrnuje.`,
              timestamp: new Date().toISOString(),
            }],
          };
          if (resolvedUserId) meetingPayload.user_id = resolvedUserId;

          const { data: newMeeting, error: meetInsertErr } = await sb.from("did_meetings").insert(meetingPayload).select().single();
          if (meetInsertErr) {
            console.warn(`[daily-cycle] Meeting insert error: ${meetInsertErr.message}`);
          } else {
            console.log(`[daily-cycle] ✅ Auto-created meeting: "${meetingTopic}" (id: ${newMeeting.id})`);

            // Send invitation emails
            const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
            if (RESEND_KEY) {
              const resendClient = new Resend(RESEND_KEY);
              const APP_URL = "https://karel-pomoc.lovable.app";
              const meetingLink = `${APP_URL}/chat?meeting=${newMeeting.id}`;
              const emailHtml = (name: string) => `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>📋 Karel svolává poradu</h2>
                  <p><strong>Téma:</strong> ${meetingTopic}</p>
                  ${meetingAgenda ? `<p><strong>Agenda:</strong></p><p>${meetingAgenda.replace(/\n/g, "<br>")}</p>` : ""}
                  <p>${name}, Karel tě zve k asynchronní poradě. Odpovědět můžeš kdykoliv v průběhu dne – Karel shrnuje průběžně.</p>
                  <p style="margin: 24px 0;">
                    <a href="${meetingLink}" style="background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
                      Připojit se k poradě →
                    </a>
                  </p>
                  <p style="color: #666; font-size: 13px;">Odkaz tě přesměruje do aplikace Karel. Pro přístup je nutné být přihlášena.</p>
                  <p>Karel</p>
                </div>
              `;
              try { await resendClient.emails.send({ from: "Karel <karel@karel-pomoc.lovable.app>", to: MAMKA_EMAIL, subject: `Karel – porada: ${meetingTopic}`, html: emailHtml("Haničko") }); } catch (e) { console.warn("Meeting invite email (Hanka):", e); }
              try { await resendClient.emails.send({ from: "Karel <karel@karel-pomoc.lovable.app>", to: KATA_EMAIL, subject: `Karel – porada: ${meetingTopic}`, html: emailHtml("Káťo") }); } catch (e) { console.warn("Meeting invite email (Kata):", e); }
            }
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

    // ═══ AUTO-FEEDBACK: Karel generates proactive feedback for stale tasks (3+ days) ═══
    try {
      const { data: staleFeedbackTasks } = await sb.from("did_therapist_tasks")
        .select("id, task, note, assigned_to, status_hanka, status_kata, created_at, priority, category, escalation_level")
        .neq("status", "done");

      if (staleFeedbackTasks && staleFeedbackTasks.length > 0) {
        const now = Date.now();
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        const staleForFeedback = staleFeedbackTasks.filter(t => 
          (now - new Date(t.created_at).getTime()) >= threeDaysMs
        );

        if (staleForFeedback.length > 0) {
          // Check which tasks already got Karel auto-feedback today
          const today = new Date().toISOString().slice(0, 10);
          const { data: existingFeedback } = await sb.from("did_task_feedback")
            .select("task_id, created_at")
            .eq("author", "karel")
            .gte("created_at", `${today}T00:00:00Z`);

          const alreadyFeedbackToday = new Set((existingFeedback || []).map((f: any) => f.task_id));
          const tasksNeedingFeedback = staleForFeedback.filter(t => !alreadyFeedbackToday.has(t.id));

          if (tasksNeedingFeedback.length > 0) {
            console.log(`[auto-feedback] Generating Karel feedback for ${tasksNeedingFeedback.length} stale tasks`);
            const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

            // Process up to 5 tasks to stay within time budget
            for (const task of tasksNeedingFeedback.slice(0, 5)) {
              try {
                const ageDays = Math.floor((now - new Date(task.created_at).getTime()) / (24 * 60 * 60 * 1000));
                const statusH = task.status_hanka || "not_started";
                const statusK = task.status_kata || "not_started";
                const statusLabel = (s: string) => s === "done" ? "splněno" : s === "in_progress" ? "rozpracováno" : "nezapočato";
                const assignedTo = task.assigned_to === "both" ? "obě terapeutky" : task.assigned_to === "hanka" ? "Hanka" : "Káťa";

                // Load motivation profile for targeted therapist
                const targetTherapist = task.assigned_to === "kata" ? "Káťa" : "Hanka";
                const { data: profile } = await sb.from("did_motivation_profiles")
                  .select("preferred_style, tasks_completed, tasks_missed, streak_current")
                  .eq("therapist", targetTherapist)
                  .maybeSingle();

                const styleHint = profile?.preferred_style === "praise"
                  ? "Používej uznání a pochvaly, motivuj pozitivně."
                  : profile?.preferred_style === "deadline"
                  ? "Buď konkrétní ohledně termínů a důsledků."
                  : profile?.preferred_style === "instruction"
                  ? "Dej jasné, konkrétní kroky co udělat."
                  : "Vyvážený přístup — pochvala + instrukce.";

                const feedbackRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: "google/gemini-2.5-flash-lite",
                    messages: [{
                      role: "system",
                      content: SYSTEM_RULES + `\n\nJsi Karel — vedoucí terapeutického týmu. Generuješ PROAKTIVNÍ zpětnou vazbu k úkolu, který je ${ageDays} dní starý a stále nesplněný.

PRAVIDLA:
- Max 2-3 věty, profesionální ale lidský tón
- Oslovovej ${task.assigned_to === "both" ? "obě terapeutky (Hanko, Káťo)" : targetTherapist}
- Zeptej se jak to jde, nebo nabídni pomoc/rozklad úkolu na menší kroky
- ${ageDays >= 7 ? "Úkol je kriticky pozadu — buď přímý a navrhni konkrétní řešení." : ageDays >= 5 ? "Úkol je pozadu — jemná urgence, nabídni pomoc." : "Připomínka — zeptej se zda nepotřebuje pomoct."}
- ${styleHint}
- NIKDY nezmiňuj profilaci, monitoring, ani že sleduješ délku plnění

ÚKOL: ${task.task}
${task.note ? `INSTRUKCE: ${task.note}` : ""}
PŘIŘAZENO: ${assignedTo}
STAV: H: ${statusLabel(statusH)}, K: ${statusLabel(statusK)}
STÁŘÍ: ${ageDays} dní
PRIORITA: ${task.priority || "normal"}
ESKALACE: level ${task.escalation_level || 0}`,
                    }, {
                      role: "user",
                      content: `Vygeneruj proaktivní zpětnou vazbu k tomuto úkolu.`,
                    }],
                  }),
                });

                if (feedbackRes.ok) {
                  const fbData = await feedbackRes.json();
                  const karelMessage = fbData.choices?.[0]?.message?.content;
                  if (karelMessage) {
                    await sb.from("did_task_feedback").insert({
                      task_id: task.id,
                      author: "karel",
                      message: karelMessage,
                    });
                    console.log(`[auto-feedback] ✅ Feedback for "${task.task.slice(0, 40)}..." (${ageDays}d old)`);
                  }
                }
              } catch (fbErr) {
                console.warn(`[auto-feedback] Error for task ${task.id}:`, fbErr);
              }
            }
          }
        }
      }
    } catch (autoFeedbackErr) {
      console.warn("[daily-cycle] Auto-feedback error (non-fatal):", autoFeedbackErr);
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
      // Store VALIDATED deterministic report, not raw AI output (anti-hallucination)
      // Include audit alerts (Case 4: new parts detected) in report summary
      const auditAlertText = auditAlerts.length > 0 ? `\n\n${auditAlerts.join("\n")}` : "";
      const validatedReportSummary = finalReportText
        ? (finalReportText + auditAlertText).slice(0, 2000)
        : (cardsUpdated.length > 0
          ? `Aktualizováno ${cardsUpdated.length} karet: ${cardsUpdated.join(", ").slice(0, 1600)}${auditAlertText}`
          : `Žádné změny${auditAlertText}`);
      await sb.from("did_update_cycles").update({
        status: hadCardUpdateErrors ? "failed" : "completed",
        completed_at: new Date().toISOString(),
        report_summary: validatedReportSummary,
        cards_updated: cardsUpdated,
        context_data: { auditAlerts: auditAlerts.length > 0 ? auditAlerts : undefined },
      }).eq("id", cycle.id);
    }

    // shadowSync moved to standalone CRON — see karel-did-context-prime (runs daily at 5:30 UTC)

    // ═══════════════════════════════════════════════════════════
    // DENNÍ REVIZE 05A/05B – expirace, downgrade, promotion
    // ═══════════════════════════════════════════════════════════
    try {
      const reviewNow = new Date().toISOString();

      // 1. Expire old plan_items
      const { data: expiredItems } = await sb.from("did_plan_items")
        .update({ status: "expired" })
        .eq("status", "active")
        .lt("expires_at", reviewNow)
        .select("id");
      if (expiredItems?.length) console.log(`[daily-cycle] Expired ${expiredItems.length} plan items`);

      // 2. Review items where review_at < now
      const { data: reviewItems } = await sb.from("did_plan_items")
        .select("*")
        .eq("status", "active")
        .lt("review_at", reviewNow);

      for (const item of (reviewItems || [])) {
        // Check last thread activity for this part
        const { data: lastThread } = await sb.from("did_threads")
          .select("last_activity_at")
          .eq("part_name", item.subject_id || "")
          .order("last_activity_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const lastActivity = lastThread?.last_activity_at ? new Date(lastThread.last_activity_at) : null;
        const hoursSinceActivity = lastActivity ? (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60) : Infinity;

        // crisis_watch + no activity 72h → downgrade to active_parts
        if (item.plan_type === "05A" && item.section === "crisis_watch" && hoursSinceActivity > 72) {
          await sb.from("did_plan_items").update({
            section: "active_parts",
            priority: "normal",
            review_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          }).eq("id", item.id);
          console.log(`[daily-cycle] Downgraded crisis_watch → active_parts: ${item.subject_id}`);
        }

        // active_parts + no activity 14d → demote to 05B
        if (item.plan_type === "05A" && hoursSinceActivity > 14 * 24) {
          await sb.from("did_plan_items").update({
            plan_type: "05B",
            section: "parts_readiness",
            status: "active",
            content: item.content + " [PŘESUNUTO Z 05A – neaktivní >14d]",
            review_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }).eq("id", item.id);
          console.log(`[daily-cycle] Demoted 05A → 05B: ${item.subject_id}`);
        }
      }

      // 3. Check 05B promotion criteria
      const { data: promotable } = await sb.from("did_plan_items")
        .select("*")
        .eq("plan_type", "05B")
        .eq("status", "active")
        .not("promotion_criteria", "is", null);

      for (const item of (promotable || [])) {
        const { data: recentThread } = await sb.from("did_threads")
          .select("id")
          .eq("part_name", item.subject_id || "")
          .gte("last_activity_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .limit(1)
          .maybeSingle();

        if (recentThread) {
          await sb.from("did_plan_items").insert({
            plan_type: "05A",
            section: "active_parts",
            subject_type: item.subject_type,
            subject_id: item.subject_id,
            content: `[POVÝŠENO Z 05B] ${item.content}`,
            priority: "high",
            action_required: item.action_required,
            assigned_to: item.assigned_to,
            status: "active",
            review_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            source_observation_ids: item.source_observation_ids,
          });
          await sb.from("did_plan_items").update({ status: "promoted" }).eq("id", item.id);
          console.log(`[daily-cycle] Promoted 05B → 05A: ${item.subject_id}`);
        }
      }

      // 4. Trigger post-intervention-sync to write updated plans to Drive
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/post-intervention-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trigger: "daily-cycle" }),
      }).catch(e => console.warn("[daily-cycle] post-intervention-sync fire-and-forget error:", e));

      console.log("[daily-cycle] Plan review completed");
    } catch (reviewErr) {
      console.warn("[daily-cycle] Plan review error (non-fatal):", reviewErr);
    }

    // ═══════════════════════════════════════════════════════════
    // FÁZE 4: OBSERVATION + CLAIM EXTRACTION Z DENNÍCH VLÁKEN
    // ═══════════════════════════════════════════════════════════
    try {
      const { createObservation, routeObservation } = await import("../_shared/observations.ts");

      // Rate limit: max 100 observations per day
      const todayDate = new Date().toISOString().slice(0, 10);
      const { count: todayObsCount } = await sb.from("did_observations")
        .select("id", { count: "exact", head: true })
        .gte("created_at", todayDate);

      const obsLimitReached = (todayObsCount || 0) >= 100;
      if (obsLimitReached) {
        console.log("[daily-cycle] Daily observation limit reached (100). Skipping extraction.");
      }

      // Process allRecentThreads (max 20) for observation + claim extraction
      const threadsForObs = (allRecentThreads || []).slice(0, 20);
      let obsCreated = 0;
      let claimsSent = 0;
      const PHASE4_TIMEOUT = 45000;
      const phase4Start = Date.now();

      for (const thread of threadsForObs) {
        if (obsLimitReached) break;
        const partName = thread.part_name || "";
        if (!partName) continue;

        const msgs = Array.isArray(thread.messages) ? (thread.messages as any[]) : [];
        const recentMsgs = msgs.slice(-20);
        if (recentMsgs.length < 2) continue;

        // 12h cooldown: skip if already processed recently
        const { data: recentObs } = await sb.from("did_observations")
          .select("id")
          .eq("source_ref", thread.id)
          .gte("created_at", new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
          .limit(1)
          .maybeSingle();
        if (recentObs) {
          console.log(`[daily-cycle] Thread ${thread.id} already processed <12h ago, skipping`);
          continue;
        }

        // ── Determine context_mode from thread metadata ──
        const subMode = thread.sub_mode || "";
        const contextMode = subMode === "cast" ? "did_parts"
          : subMode === "mamka" ? "did_therapist"
          : subMode === "kata" ? "did_therapist"
          : subMode === "general" ? "personal"
          : "work";

        // ── AI extraction of observations ──
        try {
          if (Date.now() - phase4Start > PHASE4_TIMEOUT) {
            console.warn("[daily-cycle] Phase 4 timeout, stopping extraction");
            break;
          }

          const messagesText = recentMsgs.map((m: any) => `[${m.role}]: ${m.content}`).join("\n");
          const extractionPrompt = `Analyzuj následující konverzaci a extrahuj KLINICKY RELEVANTNÍ FAKTY.

KONTEXT KONVERZACE:
- Část/osoba: "${partName}"
- Režim: ${contextMode === "did_parts" ? "přímá konverzace s částí DID systému (může být dítě!)" : contextMode === "did_therapist" ? "konverzace s terapeutkou o klientech" : contextMode === "personal" ? "osobní konverzace s Hankou (mix osobních a terapeutických témat)" : "pracovní konverzace"}

═══ KLINICKÉ PRIORITY ═══
Zaměř se na fakta indikující:
- Změnu identity (přepnutí části, signály switche)
- Sebepoškozující tendence nebo suicidální myšlenky
- Známky stabilizace nebo co-consciousness
- Emoční regulaci (úspěšnou i neúspěšnou)
- Vztahové vzorce (attachment, přenos, odpor)

═══ DISTINKCE: POZOROVÁNÍ vs SELF-REPORT ═══
- OBSERVATION = vnější pozorovatelný fakt ("Změnila tón hlasu", "Přišla pozdě")
- SELF-REPORT = co část/osoba přímo řekla o sobě ("Cítím se jako malá holka", "Mám strach")
Toto rozlišení se promítne do source_type a evidence_level.

═══ EVIDENCE LEVELS ═══
- D1 = část/osoba to PŘÍMO ŘEKLA (citace nebo parafráze výroku)
  Příklad: "Řekla: 'Bojím se tmy'" → D1
  Příklad: "Zmínila že má strach ze školy" → D1
- D2 = terapeutka to POZOROVALA (behaviorální popis)
  Příklad: "Začala se třást" → D2
  Příklad: "Změnila tón hlasu na dětský" → D2
- D3 = OBJEKTIVNÍ FAKT (čas, frekvence, logistika)
  Příklad: "Zítra má vyšetření v 10:00" → D3
  Příklad: "Třetí sezení tento týden" → D3
- I1 = INFERENCE z kontextu (Karel/AI usoudil na základě vzorce)
  Příklad: "Pravděpodobně se aktivoval trigger z minulého týdne" → I1

═══ POLE PRO KAŽDÝ FAKT ═══
- fact: co přesně bylo řečeno nebo pozorováno
- evidence_level: D1 | D2 | D3 | I1
- source_type: "self_report" (D1) | "observation" (D2/D3) | "inference" (I1)
- time_horizon: "hours" (akutní), "0_14d" (operativní), "15_60d" (strategické)
- category: jedna z [identity_switch, self_harm, stabilization, co_consciousness, emotional_regulation, emotional_state, behavior, trigger, relationship, logistics, preference, therapeutic_response, risk_signal]
- context_mode: "${contextMode}"

═══ PRAVIDLA ═══
- POUZE klinicky relevantní fakta
- "Řekla že se bojí" = D1, source_type: "self_report"
- "Zdá se úzkostná" = D2, source_type: "observation"
- "Zítra má školu" = D3, source_type: "observation"
- NEEXTRAHUJ obecné konverzační obraty ("Ahoj", "Jak se máš")
- MAX 5 faktů na vlákno
- Pokud je vlákno krátké (< 3 zprávy), o banalitách, nebo neobsahuje klinicky relevantní informace, vrať prázdné pole []. Neplýtvej kredity na bezvýznamná pozorování.
${contextMode === "personal" ? "- V osobní konverzaci extrahuj OBOJÍ: osobní fakta o Hance I DID-relevantní pozorování pokud Hanka mluví o klucích" : ""}
${contextMode === "did_parts" ? "- U dětských částí věnuj zvláštní pozornost signálům bezpečí/nebezpečí, regulaci a attachment vzorcům" : ""}

Konverzace:
${messagesText}

Odpověz POUZE jako JSON array:
[{"fact": "...", "evidence_level": "D1|D2|D3|I1", "source_type": "self_report|observation|inference", "time_horizon": "hours|0_14d|15_60d", "category": "...", "context_mode": "${contextMode}"}]
Pokud nejsou žádné nové klinicky relevantní fakty, vrať: []`;

          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          if (LOVABLE_API_KEY) {
            const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash",
                messages: [
                  { role: "system", content: "Jsi analytický asistent Karla. Extrahuj strukturovaná data z konverzací. Odpovídej POUZE ve formátu JSON." },
                  { role: "user", content: extractionPrompt },
                ],
              }),
            });

            if (aiRes.ok) {
              const aiData = await aiRes.json();
              const rawContent = aiData.choices?.[0]?.message?.content || "[]";
              let facts: Array<{ fact: string; evidence_level: string; time_horizon: string; category: string }> = [];
              try {
                const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
                if (jsonMatch) facts = JSON.parse(jsonMatch[0]);
              } catch { /* parse error */ }

              facts = facts.slice(0, 5);

              for (const fact of facts) {
                if (!["D1", "D2", "D3", "I1", "H1"].includes(fact.evidence_level)) fact.evidence_level = "D2";
                if (!["hours", "0_14d", "15_60d", "long_term"].includes(fact.time_horizon)) fact.time_horizon = "0_14d";

                try {
                  const obsId = await createObservation(sb, {
                    subject_type: fact.category === "logistics" ? "logistics" : "part",
                    subject_id: partName,
                    source_type: "thread",
                    source_ref: thread.id,
                    fact: fact.fact,
                    evidence_level: fact.evidence_level as any,
                    confidence: fact.evidence_level === "D1" ? 0.9 : fact.evidence_level === "D2" ? 0.7 : 0.8,
                    time_horizon: fact.time_horizon as any,
                  });

                  const impactType = fact.category === "risk_signal" ? "risk" as const
                    : (fact.time_horizon === "hours" ? "immediate_plan" as const
                    : fact.time_horizon === "15_60d" ? "part_profile" as const
                    : "context_only" as const);

                  await routeObservation(sb, obsId, {
                    subject_type: fact.category === "logistics" ? "logistics" : "part",
                    subject_id: partName,
                    evidence_level: fact.evidence_level,
                    time_horizon: fact.time_horizon,
                    fact: fact.fact,
                  }, impactType);
                  obsCreated++;
                } catch (obsErr) {
                  console.warn(`[daily-cycle] Single observation error for ${partName}:`, obsErr);
                }
              }
            }

            // ── AI extraction of profile claims ──
            try {
              const claimPrompt = `Analyzuj konverzaci s částí/osobou "${partName}" (režim: ${contextMode}) a extrahuj PROFILOVÁ TVRZENÍ.

TYPY CLAIMS:
- current_state: aktuální stav (VŽDY extrahuj pokud se změnil)
- stable_trait: stabilní rys (POUZE pokud je JASNÝ vzorec potvrzený opakovaně)
- trigger: identifikovaný spouštěč
- risk: rizikový faktor (sebepoškození, dekompenzace, ztráta kontaktu)
- preference: preference části/osoby
- relationship: vztahový vzorec
- therapeutic_response: reakce na terapeutický přístup
- goal: terapeutický cíl
- pattern: OPAKUJÍCÍ SE VZOREC (používej pokud se podobný jev objevil min. 2× za posledních 7 dní)
- progress: POZITIVNÍ ZMĚNA oproti předchozímu stavu (stabilizace, nová schopnost, zlepšení)

EVIDENCE LEVELS:
- D1: část/osoba to PŘÍMO ŘEKLA
- D2: terapeutka to pozorovala
- I1: inference z kontextu

PRAVIDLA:
- MAX 3 claims
- V režimu "personal": extrahuj claims o Hance (ne o klucích — ty jdou do observations)
- V režimu "did_parts": zaměř se na terapeuticky relevantní claims pro kartu části
- V režimu "did_therapist": extrahuj claims o částech na základě toho co terapeutka reportuje
- Pokud je vlákno banální nebo krátké, vrať []

Konverzace:
${messagesText}

Odpověz jako JSON array:
[{"card_section": "A|B|C|D|F|G|H|K", "claim_type": "current_state|stable_trait|trigger|risk|preference|therapeutic_response|goal|pattern|progress", "claim_text": "...", "evidence_level": "D1|D2|I1", "context_mode": "${contextMode}"}]
Pokud nejsou žádné nové claims, vrať: []`;

              const claimRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash",
                  messages: [
                    { role: "system", content: "Jsi analytický modul Karla (inspirovaný C.G. Jungem). Extrahuj profilová tvrzení z konverzací s klinickou přesností. Odpovídej POUZE JSON." },
                    { role: "user", content: claimPrompt },
                  ],
                }),
              });

              if (claimRes.ok) {
                const claimData = await claimRes.json();
                const claimContent = claimData.choices?.[0]?.message?.content || "[]";
                let claims: any[] = [];
                try {
                  const jsonMatch = claimContent.match(/\[[\s\S]*\]/);
                  if (jsonMatch) claims = JSON.parse(jsonMatch[0]).slice(0, 3);
                } catch { /* parse error */ }

                if (claims.length > 0) {
                  const profileUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/update-part-profile`;
                  await fetch(profileUrl, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      part_name: partName,
                      claims: claims.map((c: any) => ({
                        ...c,
                        confidence: c.evidence_level === "D1" ? 0.85 : c.evidence_level === "D2" ? 0.7 : 0.5,
                      })),
                    }),
                  }).catch(e => console.warn("[daily-cycle] Profile claim fire-and-forget error:", e));
                  claimsSent += claims.length;
                }
              }
            } catch (claimErr) {
              console.warn(`[daily-cycle] Claim extraction error for ${partName}:`, claimErr);
            }
          }
        } catch (obsErr) {
          console.warn(`[daily-cycle] Observation extraction error for ${partName}:`, obsErr);
        }
      }

      console.log(`[daily-cycle] Observations created: ${obsCreated}, claims sent: ${claimsSent}`);

      // ═══ DENNÍ REVIZE PENDING QUESTIONS ═══
      try {
        const pqNow = new Date().toISOString();
        // 1. Expiruj staré otázky
        await sb.from("did_pending_questions")
          .update({ status: "expired" })
          .eq("status", "open")
          .lt("expires_at", pqNow);

        // 2. Načti otevřené otázky
        const { data: openQuestions } = await sb.from("did_pending_questions")
          .select("*")
          .eq("status", "open")
          .order("created_at", { ascending: true });

        // 3. Pro každou otázku zkontroluj zda existuje nová evidence
        for (const q of (openQuestions || []).slice(0, 20)) {
          if (!q.subject_id) continue;
          const { data: newObs } = await sb.from("did_observations")
            .select("id, fact")
            .eq("subject_id", q.subject_id)
            .gt("created_at", q.created_at)
            .order("created_at", { ascending: false })
            .limit(5);

          if (newObs && newObs.length >= 2) {
            await sb.from("did_pending_questions")
              .update({
                status: "partially_answered",
                answer: `Nalezeno ${newObs.length} nových pozorování od položení otázky. Nejnovější: ${newObs[0].fact?.slice(0, 200)}`,
                answered_at: pqNow,
                answered_by: "system_daily_review",
              })
              .eq("id", q.id);
          }
        }

        console.log(`[daily-cycle] Pending questions reviewed: ${openQuestions?.length || 0} open`);
      } catch (pqErr) {
        console.warn("[daily-cycle] Pending questions review error (non-fatal):", pqErr);
      }
    } catch (phase4Err) {
      console.warn("[daily-cycle] FÁZE 4 observation pipeline error (non-fatal):", phase4Err);
    }

    // ═══ PIPELINE HEALTH CHECK (Fáze 5) ═══
    try {
      const twoDaysAgoHealth = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const [
        { count: obsCount },
        { count: claimCount },
        { count: planCount },
        { count: questionCount },
        { count: recentObsCount },
      ] = await Promise.all([
        sb.from("did_observations").select("id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("did_profile_claims").select("id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("did_plan_items").select("id", { count: "exact", head: true }).eq("status", "active"),
        sb.from("did_pending_questions").select("id", { count: "exact", head: true }).eq("status", "open"),
        sb.from("did_observations").select("id", { count: "exact", head: true }).eq("status", "active").gte("created_at", twoDaysAgoHealth),
      ]);
      console.log(`[daily-cycle] Pipeline health: obs=${obsCount}, claims=${claimCount}, plans=${planCount}, questions=${questionCount}, recent48h=${recentObsCount}`);
      if ((recentObsCount || 0) === 0) {
        console.warn("[daily-cycle] ⚠️ ALERT: Zero observations in last 48h. Pipeline may be stalled.");
      }
    } catch (healthErr) {
      console.warn("[daily-cycle] Health check error:", healthErr);
    }

    // ═══ FÁZE 5.5: VYHODNOCENÍ AKTIVNÍCH KRIZÍ ═══
    try {
      const { data: activeCrises } = await sb
        .from("crisis_events")
        .select("*")
        .not("phase", "eq", "closed");

      for (const crisis of (activeCrises || [])) {
        const daysActive = Math.ceil((Date.now() - new Date(crisis.opened_at).getTime()) / 86400000);
        await sb.from("crisis_events").update({ days_active: daysActive, updated_at: new Date().toISOString() }).eq("id", crisis.id);

        try {
          const evalUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/evaluate-crisis`;
          await fetch(evalUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ crisisId: crisis.id }),
          });
        } catch (e) { console.warn(`[daily-cycle] Crisis eval error for ${crisis.part_name}:`, e); }
      }
      console.log(`[daily-cycle] Crisis eval: ${activeCrises?.length || 0} active crises`);
    } catch (crisisErr) {
      console.warn("[daily-cycle] Crisis eval phase error (non-fatal):", crisisErr);
    }

    // ═══ FÁZE 6: AUTONOMNÍ AKTUALIZACE KARET ═══
    try {
      console.log("[daily-cycle] Triggering autonomous card updates...");
      const cardUpdateUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/run-daily-card-updates`;
      const cardUpdateRes = await fetch(cardUpdateUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const cardUpdateData = await cardUpdateRes.json().catch(() => ({}));
      console.log(`[daily-cycle] Card updates: ${cardUpdateRes.status}, processed=${cardUpdateData.partsProcessed || 0}`);
    } catch (cardUpdateErr) {
      console.warn("[daily-cycle] Card updates error (non-fatal):", cardUpdateErr);
    }

    // ═══ FÁZE 6.5: CLEANUP STARÉ PAMĚTI ═══
    try {
      const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString();
      const { count: deletedMem } = await sb.from("session_memory")
        .delete()
        .lt("session_date", cutoff90)
        .eq("manually_edited", false);

      const promiseCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      await sb.from("karel_promises")
        .update({ status: "cancelled" })
        .eq("status", "active")
        .lt("created_at", promiseCutoff);

      console.log(`[daily-cycle] Memory cleanup: deleted ${deletedMem || 0} old memories`);
    } catch (memCleanErr) {
      console.warn("[daily-cycle] Memory cleanup error (non-fatal):", memCleanErr);
    }

    // ═══ FÁZE 6.6: AI ERROR LOG CLEANUP ═══
    try {
      const logCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      await sb.from("ai_error_log").delete().lt("created_at", logCutoff);
      console.log("[daily-cycle] AI error log cleanup done");
    } catch (e) {
      console.warn("[daily-cycle] AI error log cleanup failed:", e);
    }

    // ═══ FÁZE 6.7: CHECK UNREAD THERAPIST NOTES ═══
    try {
      const { count: unreadNotes } = await sb.from("therapist_notes")
        .select("id", { count: "exact", head: true })
        .eq("is_read_by_karel", false);

      const { data: urgentNotes } = await sb.from("therapist_notes")
        .select("author, part_name, note_text, priority")
        .eq("is_read_by_karel", false)
        .eq("priority", "urgent")
        .limit(5);

      if (urgentNotes?.length) {
        console.log(`[daily-cycle] ⚠️ ${urgentNotes.length} URGENT unread therapist notes!`);
      }
      console.log(`[daily-cycle] Unread therapist notes: ${unreadNotes || 0} (urgent: ${urgentNotes?.length || 0})`);
    } catch (tnErr) {
      console.warn("[daily-cycle] Therapist notes check error (non-fatal):", tnErr);
    }

    // ═══ FÁZE 6.8: COMPUTE DAILY METRICS ═══
    try {
      const metricsUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/compute-daily-metrics`;
      const metricsRes = await fetch(metricsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        }),
      });
      const metricsData = await metricsRes.json();
      console.log(`[daily-cycle] Metrics computed: ${metricsRes.status}`, metricsData);
    } catch (metricsErr) {
      console.warn("[daily-cycle] Metrics computation error (non-fatal):", metricsErr);
    }

    // ═══ FÁZE 6.9: AUTO-HODNOCENÍ CÍLŮ ═══
    console.log("[daily-cycle] Evaluating goals...");
    try {
      const { data: activeGoals } = await sb.from("part_goals").select("*").eq("status", "active");

      if (activeGoals && activeGoals.length > 0) {
        const LOVABLE_API_KEY_GOALS = Deno.env.get("LOVABLE_API_KEY");

        for (const goal of activeGoals) {
          try {
            const recentDate = new Date(Date.now() - 3 * 86400000).toISOString();
            const [threadsRes, metricsRes, memoryRes] = await Promise.all([
              sb.from("did_threads").select("messages").eq("part_name", goal.part_name).gte("updated_at", recentDate).order("updated_at", { ascending: false }).limit(3),
              sb.from("daily_metrics").select("*").eq("part_name", goal.part_name).order("metric_date", { ascending: false }).limit(3),
              sb.from("session_memory").select("key_points, emotional_state, positive_signals, risk_signals").eq("part_name", goal.part_name).gte("created_at", recentDate).limit(5),
            ]);

            let conversationSample = "";
            for (const t of (threadsRes.data || [])) {
              const msgs = Array.isArray(t.messages) ? t.messages : [];
              conversationSample += msgs.slice(-6).map((m: any) => `[${m.role}]: ${(m.content || "").slice(0, 200)}`).join("\n") + "\n---\n";
            }

            const memoryContext = (memoryRes.data || []).map((m: any) => `Stav: ${m.emotional_state}, Klíčové: ${(m.key_points || []).join(", ")}`).join("\n");
            const metricsContext = (metricsRes.data || []).map((m: any) => `${m.metric_date}: valence=${m.emotional_valence ?? "?"}, spolupráce=${m.cooperation_level ?? "?"}`).join("\n");

            if (LOVABLE_API_KEY_GOALS && conversationSample.length > 50) {
              const { callAiForJson } = await import("../_shared/aiCallWrapper.ts");

              const evalResult = await callAiForJson({
                systemPrompt: `Jsi hodnotitel terapeutických cílů. Máš cíl pro část "${goal.part_name}" a kontext z posledních 3 dnů. Ohodnoť pokrok.`,
                userPrompt: `CÍL: ${goal.goal_text}\n${goal.description ? `POPIS: ${goal.description}` : ""}\nKATEGORIE: ${goal.category}\nAKTUÁLNÍ POKROK: ${goal.progress_pct}%\n${goal.milestones ? `MILNÍKY: ${JSON.stringify(goal.milestones)}` : ""}\n\nKONVERZACE:\n${conversationSample.slice(0, 3000)}\n\nPAMĚŤ:\n${memoryContext.slice(0, 1000)}\n\nMETRIKY:\n${metricsContext}\n\nVrať JSON:\n{"new_progress_pct": 0-100, "evaluation_text": "stručné hodnocení česky (max 2 věty)", "milestones_update": [{"text": "...", "done": true/false}], "should_complete": false, "reasoning": "proč"}\n\nPRAVIDLA: Pokrok max +15%/den, nemůže klesnout, should_complete jen při jasném splnění.`,
                apiKey: LOVABLE_API_KEY_GOALS,
                model: "google/gemini-2.5-flash-lite",
                requiredKeys: ["new_progress_pct", "evaluation_text"],
                maxRetries: 0,
                fallback: null,
                callerName: "goal-evaluation",
              });

              if (evalResult.success && evalResult.data) {
                const ev = evalResult.data as any;
                const oldPct = goal.progress_pct || 0;
                let newPct = Math.min(100, Math.max(oldPct, Math.min(oldPct + 15, ev.new_progress_pct || oldPct)));

                const updateData: any = {
                  progress_pct: newPct,
                  evaluation_notes: ev.evaluation_text,
                  last_evaluated_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };

                if (ev.milestones_update?.length) updateData.milestones = ev.milestones_update;
                if (ev.should_complete && newPct >= 90) {
                  updateData.status = "completed";
                  updateData.completed_at = new Date().toISOString();
                  updateData.progress_pct = 100;
                }

                await sb.from("part_goals").update(updateData).eq("id", goal.id);
                await sb.from("goal_evaluations").insert({
                  goal_id: goal.id, previous_progress: oldPct, new_progress: newPct,
                  evaluation_text: ev.evaluation_text, evidence: { reasoning: ev.reasoning },
                }).catch(() => {});

                console.log(`[daily-cycle] Goal "${(goal.goal_text || "").slice(0, 30)}": ${oldPct}% → ${newPct}%${ev.should_complete ? " (COMPLETED!)" : ""}`);
              }
            }
          } catch (goalErr) {
            console.warn(`[daily-cycle] Goal eval error:`, goalErr);
          }
        }
      }
      console.log("[daily-cycle] Goal evaluation done");
    } catch (goalsErr) {
      console.warn("[daily-cycle] Goals phase failed:", goalsErr);
    }

    // ═══ AUTO-NÁVRH NOVÝCH CÍLŮ ═══
    try {
      const todayStart = new Date().toISOString().slice(0, 10);
      const { count: todayProposed } = await sb.from("part_goals").select("id", { count: "exact", head: true }).eq("proposed_by", "karel").gte("created_at", todayStart);

      if ((todayProposed || 0) < 2) {
        const { data: allActiveParts } = await sb.from("did_part_registry").select("part_name").eq("status", "active");
        const { data: partsWithGoals } = await sb.from("part_goals").select("part_name").in("status", ["active", "proposed"]);
        const partsWithGoalNames = [...new Set((partsWithGoals || []).map((g: any) => g.part_name))];
        const partsWithoutGoals = (allActiveParts || []).filter((p: any) => !partsWithGoalNames.includes(p.part_name));

        const LOVABLE_API_KEY_PROP = Deno.env.get("LOVABLE_API_KEY");
        if (partsWithoutGoals.length > 0 && LOVABLE_API_KEY_PROP) {
          const targetPart = partsWithoutGoals[0].part_name;
          const { data: recentMem } = await sb.from("session_memory").select("key_points, unresolved, risk_signals, positive_signals").eq("part_name", targetPart).order("created_at", { ascending: false }).limit(5);

          const { callAiForJson: callAiGoal } = await import("../_shared/aiCallWrapper.ts");
          const proposalResult = await callAiGoal({
            systemPrompt: `Jsi Karel — klinický psycholog. Navrhni JEDEN konkrétní, měřitelný terapeutický micro-cíl pro část "${targetPart}".`,
            userPrompt: `POSLEDNÍ PAMĚŤ:\n${(recentMem || []).map((m: any) => `Klíčové: ${(m.key_points || []).join(", ")}\nNedořešené: ${(m.unresolved || []).join(", ")}`).join("\n---\n")}\n\nNavrhni JSON:\n{"goal_text": "stručný cíl (max 100 znaků)", "description": "popis a kritéria splnění", "category": "therapeutic|behavioral|emotional|relational|safety|integration|communication|daily_life", "priority": "low|normal|high", "milestones": [{"text": "první krok", "done": false}]}`,
            apiKey: LOVABLE_API_KEY_PROP,
            model: "google/gemini-2.5-flash",
            requiredKeys: ["goal_text", "category"],
            maxRetries: 0,
            fallback: null,
            callerName: "goal-proposal",
          });

          if (proposalResult.success && proposalResult.data) {
            const p = proposalResult.data as any;
            await sb.from("part_goals").insert({
              part_name: targetPart, goal_text: (p.goal_text || "").slice(0, 200),
              description: (p.description || "").slice(0, 500), category: p.category || "therapeutic",
              priority: p.priority || "normal", milestones: p.milestones || [],
              status: "proposed", proposed_by: "karel",
            });
            console.log(`[daily-cycle] Karel proposed goal for ${targetPart}: "${(p.goal_text || "").slice(0, 50)}"`);
          }
        }
      }
    } catch (propErr) {
      console.warn("[daily-cycle] Goal proposal error:", propErr);
    }

    // ═══ FÁZE 7: Aktualizace operativního plánu ═══
    try {
      const planUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/update-operative-plan`;
      const planRes = await fetch(planUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "daily-cycle" }),
      });
      console.log(`[daily-cycle] Plan update: ${planRes.status}`);
    } catch (planErr) {
      console.warn("[daily-cycle] Plan update error (non-fatal):", planErr);
    }

    // ═══ FÁZE 7.5: CLEANUP OLD SAFETY ALERTS ═══
    try {
      const alertCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      await sb.from("safety_alerts").delete().in("status", ["resolved", "false_positive"]).lt("created_at", alertCutoff);
      console.log("[daily-cycle] Old safety alerts cleanup done");
    } catch (e) {
      console.warn("[daily-cycle] Safety alerts cleanup failed:", e);
    }

    try {
      const refreshUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-daily-refresh`;
      const refreshRes = await fetch(refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
        },
        body: JSON.stringify({ source: "daily-cycle-post" }),
      });
      console.log(`[daily-cycle] karel-daily-refresh triggered: ${refreshRes.status}`);
    } catch (e) {
      console.warn("[daily-cycle] Failed to trigger karel-daily-refresh (non-fatal):", e);
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
