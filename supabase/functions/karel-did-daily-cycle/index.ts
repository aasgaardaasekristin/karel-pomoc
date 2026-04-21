import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";
import {
  readUnprocessedPantryB,
  markPantryBProcessed,
  purgeExpiredPantryB,
} from "../_shared/pantryB.ts";

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

// ── Memory-safe variants for AUDIT-0B (auditCardStructure) ──
// Hard ceiling – any card whose serialized text exceeds this is skipped to avoid OOM.
const MAX_AUDIT_CARD_BYTES = 250_000; // ~250 KB
class CardOversizedError extends Error {
  byteLength: number;
  constructor(byteLength: number) {
    super(`card exceeds MAX_AUDIT_CARD_BYTES (${byteLength} > ${MAX_AUDIT_CARD_BYTES})`);
    this.name = "CardOversizedError";
    this.byteLength = byteLength;
  }
}

// Cheap pre-flight: ask Drive for the file size before downloading anything.
// For native Google Docs `size` is null/undefined – returns null and caller falls through to streamed cap.
async function getDriveFileSize(token: string, fileId: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { size?: string } | null;
    if (!j || j.size == null) return null;
    const n = Number(j.size);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Streamed read with hard byte cap. Aborts the fetch as soon as cap is exceeded
// so we never materialize the whole oversized payload in memory.
async function readFileContentCapped(token: string, fileId: string, maxBytes: number): Promise<string> {
  const tryRead = async (url: string): Promise<{ ok: boolean; status: number; text?: string; oversized?: number }> => {
    const ctrl = new AbortController();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!res.ok) {
      try { ctrl.abort(); } catch { /* ignore */ }
      return { ok: false, status: res.status };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      // Fallback – no streaming reader. Use Content-Length if present, else bail out via .text() guarded by length check.
      const len = Number(res.headers.get("content-length") || "0");
      if (len > maxBytes) {
        try { ctrl.abort(); } catch { /* ignore */ }
        return { ok: true, status: res.status, oversized: len };
      }
      const text = await res.text();
      if (text.length > maxBytes) return { ok: true, status: res.status, oversized: text.length };
      return { ok: true, status: res.status, text };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        try { ctrl.abort(); } catch { /* ignore */ }
        return { ok: true, status: res.status, oversized: total };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return { ok: true, status: res.status, text: new TextDecoder().decode(merged) };
  };

  let r = await tryRead(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!r.ok) {
    r = await tryRead(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`);
    if (!r.ok) throw new Error(`Cannot read file ${fileId}: ${r.status}`);
  }
  if (r.oversized != null) throw new CardOversizedError(r.oversized);
  return r.text || "";
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
        else if (/^═*\s*SEKCE\s+[A-N]\s*[–\-:]/i.test(line)) {
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
  N: "Karlův plán příštího sezení",
};
const SECTION_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

function sectionHeader(letter: string): string {
  return `SEKCE ${letter} – ${SECTION_DEFINITIONS[letter]}`;
}

function parseCardSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const strictRegex = /(?:═+\s*)?SEKCE\s+([A-N])\s*[–\-:]/gi;
  let matches = [...content.matchAll(strictRegex)];
  if (matches.length === 0) {
    const looseRegex = /^##?\s*([A-N])\s*[–\-:)]\s*/gmi;
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

    // DEEPEN mode: append only new insights, preserve existing content
    if (mode === "DEEPEN") {
      const hash = contentHash(newContent.trim());
      if (existing && hasKhash(existing, hash)) {
        console.log(`[KHASH-dedup] Skipping section ${ul} for "${partName}" (DEEPEN mode) – hash ${hash} already present`);
        dedupSkips++;
        continue;
      }
      const timestampedDeepen = `[${dateStr}] ${newContent} [KHASH:${hash}]`;
      if (existing && existing !== "(zatím prázdné)") {
        existingSections[ul] = existing + "\n\n---\n\n" + timestampedDeepen;
      } else {
        existingSections[ul] = timestampedDeepen;
      }
      updatedKeys.push(ul);
      console.log(`[updateCardSections] DEEPEN section ${ul} for "${partName}" (${newContent.length} chars appended to ${existing.length} chars existing)`);
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
  return /SEKCE\s+[A-N]\s*[–\-:]/i.test(content) || /KARTA\s+ČÁSTI/i.test(content);
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
  oversized?: boolean; // skipped due to MAX_AUDIT_CARD_BYTES guard
  byteLength?: number; // observed size when oversized or pre-checked
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

  // ─── Memory guard: pre-check size when Drive reports it (binary files) ───
  const reportedSize = await getDriveFileSize(token, fileId);
  if (reportedSize != null && reportedSize > MAX_AUDIT_CARD_BYTES) {
    console.warn(`[AUDIT-0B] OVERSIZED "${fileName}" (${reportedSize} B > ${MAX_AUDIT_CARD_BYTES} B) – skipping audit, no read`);
    return {
      partName, fileName,
      changes: [`SKIP: karta je příliš velká (${reportedSize} B) – audit přeskočen`],
      promoted: false, created: false,
      alertForHanka: `⚠️ Strukturální audit přeskočen pro "${partName}" – karta je příliš velká (${reportedSize} B). Doporučuji ruční rozdělení/archivaci.`,
      oversized: true, byteLength: reportedSize,
    };
  }

  let content: string;
  try {
    // Streamed read with hard byte cap – aborts download if card grows past the ceiling.
    content = await readFileContentCapped(token, fileId, MAX_AUDIT_CARD_BYTES);
  } catch (e) {
    if (e instanceof CardOversizedError) {
      console.warn(`[AUDIT-0B] OVERSIZED "${fileName}" (stream cap hit at ${e.byteLength} B) – skipping audit`);
      return {
        partName, fileName,
        changes: [`SKIP: karta je příliš velká (~${e.byteLength} B) – audit přeskočen`],
        promoted: false, created: false,
        alertForHanka: `⚠️ Strukturální audit přeskočen pro "${partName}" – karta překročila limit ${MAX_AUDIT_CARD_BYTES} B. Doporučuji ruční rozdělení/archivaci.`,
        oversized: true, byteLength: e.byteLength,
      };
    }
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
// ═══ HELPER: sendOrQueueEmail — sends via Resend or queues to did_pending_emails ═══
async function sendOrQueueEmail(
  sb: any,
  params: {
    toEmail: string;
    toName: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    emailType: string;
    fromAddress?: string;
    isRetry?: boolean;
  }
): Promise<{ sent: boolean; queued: boolean; error?: string }> {
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const fromAddr = params.fromAddress || "Karel <karel@hana-chlebcova.cz>";

  if (!params.toEmail) {
    console.warn(`[EMAIL SKIP] No email address for ${params.toName}`);
    return { sent: false, queued: false, error: "No email address" };
  }

  if (RESEND_KEY) {
    try {
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [params.toEmail],
          subject: params.subject,
          html: params.bodyHtml,
          text: params.bodyText || "",
        }),
      });

      if (resendRes.ok) {
        console.log(`[EMAIL SENT] → ${params.toName} (${params.toEmail}): ${params.subject}`);
        return { sent: true, queued: false };
      } else {
        const errText = await resendRes.text();
        throw new Error(`Resend ${resendRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.error(`[EMAIL FAILED] ${params.toEmail}: ${e.message}`);
      if (!params.isRetry) {
        try {
          await sb.from("did_pending_emails").insert({
            to_email: params.toEmail,
            to_name: params.toName,
            subject: params.subject,
            body_html: params.bodyHtml,
            body_text: params.bodyText || "",
            email_type: params.emailType,
            status: "pending",
            error_message: e.message,
            next_retry_at: new Date(Date.now() + 30 * 60000).toISOString(),
          });
          console.log(`[EMAIL QUEUED] ${params.subject} → did_pending_emails`);
        } catch (queueErr) {
          console.warn("[EMAIL QUEUE INSERT FAILED]", queueErr);
        }
      }
      return { sent: false, queued: !params.isRetry, error: e.message };
    }
  } else {
    // No Resend key → queue
    if (!params.isRetry) {
      try {
        await sb.from("did_pending_emails").insert({
          to_email: params.toEmail,
          to_name: params.toName,
          subject: params.subject,
          body_html: params.bodyHtml,
          body_text: params.bodyText || "",
          email_type: params.emailType,
          status: "pending",
          error_message: "Missing RESEND_API_KEY",
          next_retry_at: new Date(Date.now() + 60 * 60000).toISOString(),
        });
        console.log(`[EMAIL QUEUED] No RESEND_API_KEY — ${params.subject} → did_pending_emails`);
      } catch (queueErr) {
        console.warn("[EMAIL QUEUE INSERT FAILED]", queueErr);
      }
    }
    return { sent: false, queued: !params.isRetry, error: "No RESEND_API_KEY" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // ═══ ADMIN ACTIONS (no dedup, no auth-fence beyond JWT) ═══
  // Parse body once for early routing.
  let earlyBody: any = {};
  try { earlyBody = await req.clone().json(); } catch {}
  const adminAction = earlyBody?.action as string | undefined;
  const isManualTriggerEarly = earlyBody?.source === "manual";

  // ── status: read-only snapshot of last completed + currently running cycle ──
  if (adminAction === "status") {
    const adminSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [completedRes, runningRes] = await Promise.all([
      adminSb.from("did_update_cycles")
        .select("id, started_at, completed_at, status, phase, last_error, report_summary")
        .eq("cycle_type", "daily").eq("status", "completed")
        .order("completed_at", { ascending: false }).limit(1).maybeSingle(),
      adminSb.from("did_update_cycles")
        .select("id, started_at, status, phase, phase_detail, heartbeat_at, last_error")
        .eq("cycle_type", "daily").eq("status", "running")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const running = runningRes.data as any;
    let heartbeatAgeSec: number | null = null;
    let stuck = false;
    if (running) {
      const hb = running.heartbeat_at ? new Date(running.heartbeat_at).getTime() : new Date(running.started_at).getTime();
      heartbeatAgeSec = Math.floor((Date.now() - hb) / 1000);
      stuck = heartbeatAgeSec > 30 * 60;
    }
    return new Response(JSON.stringify({
      ok: true,
      lastCompleted: completedRes.data || null,
      running: running ? { ...running, heartbeatAgeSec, stuck } : null,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ── force_fail: mark current running cycle as failed (admin recovery) ──
  if (adminAction === "force_fail") {
    const adminSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const targetId = (earlyBody?.cycleId as string | undefined) || null;
    let q = adminSb.from("did_update_cycles").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      last_error: `manual_force_fail_via_admin_ui${earlyBody?.reason ? `:${String(earlyBody.reason).slice(0, 120)}` : ""}`,
    }).eq("status", "running").eq("cycle_type", "daily");
    if (targetId) q = q.eq("id", targetId);
    const { data, error } = await q.select("id");
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, failedCount: data?.length ?? 0, ids: (data || []).map((r: any) => r.id) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // === DEDUP: Skip if a successful daily cycle completed in last 3 hours ===
  // Manual admin trigger (source="manual") bypasses dedup so the harness
  // can prove an end-to-end run on demand.
  if (!isManualTriggerEarly) {
    const dedupSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const recentCycle = await dedupSb
      .from('did_update_cycles')
      .select('id, completed_at')
      .eq('cycle_type', 'daily')
      .eq('status', 'completed')
      .gte('completed_at', new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString())
      .limit(1);
    if (recentCycle.data?.length) {
      console.log('[DAILY-CYCLE] Přeskočeno — proběhl úspěšně v posledních 3h');
      return new Response(
        JSON.stringify({ status: 'skipped', reason: 'recent_success', lastCycleId: recentCycle.data[0].id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

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

  // ═══ CACHE INVALIDATION: Clear context-prime caches so fresh context is generated ═══
  if (resolvedUserId) {
    const cacheInvalidSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    try {
      const { count } = await cacheInvalidSb
        .from("context_cache")
        .delete({ count: "exact" })
        .eq("user_id", resolvedUserId)
        .in("function_name", ["did-context-prime", "hana-context-prime"]);
      console.log(`[daily-cycle] Cache invalidated: ${count ?? 0} entries deleted for context-prime functions`);
    } catch (cacheErr) {
      console.warn("[daily-cycle] Cache invalidation failed (non-fatal):", cacheErr);
    }
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
  const suppressEmails = requestBody?.suppressEmails === true;
  const shouldSendEmails = !suppressEmails && (isAfternoonCronWindow || isTestEmail || isCatchup || isWatchdog);
  console.log(`[daily-cycle] Email Guard: pragueHour=${pragueHourForEmailGuard}, isCronCall=${isCronCall}, isCatchup=${isCatchup}, isWatchdog=${isWatchdog}, suppressEmails=${suppressEmails}, shouldSendEmails=${shouldSendEmails}`);

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

    // ═══ ENV DIAGNOSTICS ═══
    const envDiag = {
      RESEND_API_KEY: !!RESEND_API_KEY,
      KATA_EMAIL: KATA_EMAIL || null,
      MAMKA_EMAIL: !!MAMKA_EMAIL,
      LOVABLE_API_KEY: !!LOVABLE_API_KEY,
      PERPLEXITY_API_KEY: !!Deno.env.get("PERPLEXITY_API_KEY"),
      GOOGLE_CLIENT_ID: !!Deno.env.get("GOOGLE_CLIENT_ID"),
    };
    console.log("[ENV DIAG]", JSON.stringify(envDiag));

    const missingCritical: string[] = [];
    if (!RESEND_API_KEY) missingCritical.push("RESEND_API_KEY");
    if (!KATA_EMAIL && !MAMKA_EMAIL) missingCritical.push("KATA_EMAIL nebo MAMKA_EMAIL (žádný email pro terapeutky)");
    if (!LOVABLE_API_KEY) missingCritical.push("LOVABLE_API_KEY");

    if (missingCritical.length > 0) {
      console.error(`[ENV CRITICAL] Chybí: ${missingCritical.join(", ")}`);
      try {
        await sb.from("system_health_log").insert({
          event_type: "missing_env",
          severity: "critical",
          message: `Chybějící env proměnné: ${missingCritical.join(", ")}`,
          details: envDiag,
        });
      } catch {}
    }

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
      if (!shouldSendEmails) return false;
      const reserved = await reserveDispatchSlot(recipient);
      if (!reserved) return false;

      try {
        const result = await sendOrQueueEmail(sb!, {
          toEmail: to,
          toName: recipient,
          subject,
          bodyHtml: html,
          emailType: "daily_report",
        });
        if (result.sent) {
          await markDispatchSent(recipient);
          return true;
        } else if (result.queued) {
          await markDispatchFailed(recipient, result.error || "queued");
          return false;
        }
        return false;
      } catch (e) {
        await markDispatchFailed(recipient, e instanceof Error ? e.message : String(e));
        throw e;
      }
    };

    // ═══ PRE-PIPELINE: Run daily analyzer to populate analysis_json ═══
    try {
      console.log("[daily-cycle] Invoking karel-did-daily-analyzer...");
      const analyzerRes = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-did-daily-analyzer`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ source: "daily-cycle" }),
        }
      );
      console.log(`[daily-cycle] Daily analyzer returned ${analyzerRes.status}`);
    } catch (analyzerErr) {
      console.warn("[daily-cycle] Daily analyzer failed (non-fatal):", analyzerErr);
    }

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
    const rawHanaConversations = hanaConvRows ?? [];
    // HANA_PERSONAL_FILTER: osobní data Hanky jdou pouze do PAMET_KAREL, nikdy do DID pipeline
    // Propustit pouze konverzace obsahující DID-relevantní obsah
    const recentHanaConversations = rawHanaConversations
      .map((conv: any) => {
        const messages = (Array.isArray(conv.messages) ? conv.messages : [])
          .filter((m: any) => m?.domain === "DID" || m?.domain === "PRACE" ||
            (typeof m?.content === "string" && (m.content.includes("[DID]") || m.content.includes("[PRACE]"))));
        return messages.length > 0 ? { ...conv, messages } : null;
      })
      .filter(Boolean);
    console.log(`[daily-cycle] Hana conversations (24h): raw=${rawHanaConversations.length}, DID-filtered=${recentHanaConversations.length}`);

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

    // Load pending therapist tasks for accountability analysis.
    // ⚠️ MEMORY GUARD: hard cap at 200 oldest pending tasks. Loading the full
    // open-task set (currently >7k) caused OOM crashes mid-cycle, killing the
    // run BEFORE Phase 4 extraction could create did_observations /
    // did_implications. Older tasks are still escalated by their own existing
    // escalation_level metadata; this slice only bounds in-memory size.
    const { data: pendingTasks } = await sb.from("did_therapist_tasks")
      .select("id, task, detail_instruction, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, note, escalation_level, escalated_at, last_escalation_email_at")
      .in("status", ["pending", "active", "in_progress", "not_started"])
      .order("created_at", { ascending: true })
      .limit(200);

    // ═══ HEURISTICKÁ KONTROLA SPLNĚNÍ ÚKOLŮ ═══
    try {
      const { data: recentNotes } = await sb.from("therapist_notes")
        .select("author, note_text, created_at, part_name")
        .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
        .order("created_at", { ascending: false });

      for (const task of (pendingTasks || [])) {
        if (task.status === "done" || task.status === "needs_review") continue;
        const taskWords = (task.task || "").toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
        if (taskWords.length === 0) continue;

        const assignee = (task.assigned_to || "").toLowerCase();
        const relevantNotes = (recentNotes || []).filter((n: any) => {
          if (new Date(n.created_at) <= new Date(task.created_at)) return false;
          const authorMatch = assignee === "both" || (n.author || "").toLowerCase().includes(assignee);
          if (!authorMatch) return false;
          const noteText = (n.note_text || "").toLowerCase();
          const matchCount = taskWords.filter((w: string) => noteText.includes(w)).length;
          return matchCount / taskWords.length >= 0.4;
        });

        if (relevantNotes.length > 0) {
          await sb.from("did_therapist_tasks").update({
            status: "needs_review",
            note: `Možná splněno — Karel nalezl související aktivitu od ${new Date(relevantNotes[0].created_at).toLocaleDateString("cs-CZ")}`,
          } as any).eq("id", task.id);
          console.log(`[TASK HEURISTIC] "${(task.task || "").slice(0, 40)}" → needs_review`);
        }
      }
    } catch (heuErr) {
      console.warn("[daily-cycle] Heuristic task check error:", heuErr);
    }

    // ═══ SYSTÉMOVÁ ESKALACE NESPLNĚNÝCH ÚKOLŮ ═══
    const overdueTasks: Array<{ task: any; daysOverdue: number; assignee: string; escalationLevel: string }> = [];
    for (const task of (pendingTasks || [])) {
      if (task.status === "done" || task.status === "needs_review") continue;
      const createdAt = new Date(task.created_at);
      const daysOld = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

      let escalationLevel = "none";
      if (daysOld >= 7) {
        escalationLevel = "critical";
        await sb.from("did_therapist_tasks").update({
          priority: "urgent",
          escalation_level: "critical",
          escalated_at: new Date().toISOString(),
        } as any).eq("id", task.id);
      } else if (daysOld >= 3) {
        escalationLevel = "warning";
        await sb.from("did_therapist_tasks").update({
          escalation_level: "warning",
          escalated_at: new Date().toISOString(),
        } as any).eq("id", task.id);
      }

      if (escalationLevel !== "none") {
        overdueTasks.push({ task, daysOverdue: daysOld, assignee: task.assigned_to || "nespecifikováno", escalationLevel });
      }
    }
    console.log(`[TASK ESCALATION] ${overdueTasks.length} úkolů eskalováno (${overdueTasks.filter(t => t.escalationLevel === "critical").length} critical)`);

    const pendingTasksSummary = (pendingTasks || []).map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
      const escLabel = age >= 7 ? " 🔴 CRITICAL" : age >= 3 ? " ⚠️ ESKALACE" : "";
      return `- [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}${escLabel}`;
    }).join("\n");
    console.log(`[daily-cycle] Pending therapist tasks: ${pendingTasks?.length || 0}`);

    // ═══ THERAPIST PROFILING: Silent load of motivation profiles for both therapists ═══
    const { data: motivationProfileRows } = await sb.from("did_motivation_profiles")
      .select("therapist, preferred_style, praise_effectiveness, deadline_effectiveness, instruction_effectiveness, streak_current, streak_best, tasks_completed, tasks_missed, avg_completion_days, last_active_at, notes");
    const motivationProfiles = motivationProfileRows ?? [];
    console.log(`[daily-cycle] Motivation profiles loaded: ${motivationProfiles.length}`);
    const motivationContext = motivationProfiles.map((p: any) => {
      const completionRate = (p.tasks_completed + p.tasks_missed) > 0
        ? Math.round((p.tasks_completed / (p.tasks_completed + p.tasks_missed)) * 100)
        : 0;
      return `═ Motivační profil: ${p.therapist} ═
Preferovaný styl vedení: ${p.preferred_style}
Efektivita motivace – pochvaly: ${p.praise_effectiveness}/5, termíny: ${p.deadline_effectiveness}/5, instrukce: ${p.instruction_effectiveness}/5
Streak (aktuální/nejlepší): ${p.streak_current}/${p.streak_best}
Splněno úkolů: ${p.tasks_completed}, nesplněno: ${p.tasks_missed} (úspěšnost: ${completionRate}%)
Průměrná doba splnění: ${p.avg_completion_days || "?"} dní
Poslední aktivita: ${p.last_active_at || "neznámo"}
Poznámky Karla: ${p.notes || "(žádné)"}`;
    }).join("\n\n");

    // ═══ THERAPIST PROFILES: Load AI-generated profiles (F17-D5) ═══
    const { data: therapistProfileRows } = await sb.from("therapist_profiles")
      .select("therapist_name, strengths, preferred_methods, preferred_part_types, communication_style, experience_areas, limitations, workload_capacity");
    const tpContext = (therapistProfileRows || []).map((tp: any) => `═ Profil terapeutky: ${tp.therapist_name === "hanka" ? "Hanka" : "Káťa"} ═
Silné stránky: ${(tp.strengths || []).join(", ") || "N/A"}
Metody: ${(tp.preferred_methods || []).join(", ") || "N/A"}
Typy částí: ${(tp.preferred_part_types || []).join(", ") || "N/A"}
Styl komunikace: ${tp.communication_style || "N/A"}
Oblasti zkušeností: ${(tp.experience_areas || []).join(", ") || "N/A"}
Limitace: ${(tp.limitations || []).join(", ") || "N/A"}
Kapacita: ${tp.workload_capacity || "normal"}

Při doporučení v sekci D (DOPORUČENÝ TERAPEUT) a sekci N (PLÁN SEZENÍ):
- Přiřazuj části terapeutkám podle preferred_part_types a preferred_methods
- Zohledni aktuální workload_capacity
- Pokud obě terapeutky jsou vhodné, preferuj tu s nižším workloadem`).join("\n\n");

    const therapistProfileContext = [motivationContext, tpContext].filter(Boolean).join("\n\n");

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
      // bypassDispatchCheck flag (admin/proof-run only) skips this gate so we can verify
      // full pipeline regardless of whether emails already went out.
      const bypassDispatchCheck = requestBody?.bypassDispatchCheck === true;
      if (currentSlot === "afternoon" && !bypassDispatchCheck) {
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
      } else if (bypassDispatchCheck) {
        console.log(`[daily-cycle] bypassDispatchCheck=true → skipping dispatch gate (admin/proof run)`);
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
    // E3: stuck/concurrency window prodloužen z 10 → 30 minut.
    // Důvod: realný daily-cycle běží i přes 10 min (AI fáze 3b/4/6).
    // Kratší okno generovalo false-positive "stale_running".
    // Live cycle nyní povinně volá setPhase(...) → heartbeat_at,
    // takže opravdu zaseknutý cycle poznáme podle starého heartbeatu,
    // ne podle started_at.
    const STUCK_WINDOW_MIN = 30;
    const stuckCutoff = new Date(Date.now() - STUCK_WINDOW_MIN * 60 * 1000).toISOString();

    // ═══ Sjednocená definice "live" vs "stuck" run ═══
    // LIVE  = status='running' AND coalesce(heartbeat_at, started_at) >= stuckCutoff
    //         (čerstvý heartbeat NEBO ještě nestihl první setPhase)
    // STUCK = status='running' AND coalesce(heartbeat_at, started_at) <  stuckCutoff
    //         (nikdo neheartbeatl už 30+ min — opravdu zaseklý běh)
    // Tyto dvě množiny jsou disjunktní a pokrývají všechny running runy.
    //
    // Důsledek: healthy daily-cycle, který běží 2h ale heartbeat-uje,
    // je pořád LIVE → další spuštění uvidí concurrency a skipne.

    // 1) AUTO-CLEANUP nejdřív — ať uvolníme zombie running rows,
    //    aby nás neblokoval guard kvůli starému started_at bez heartbeatu.
    //    Toto je JEDINÝ cleanup path pro daily cycles — analyst-loop je má vyřazené (E2).
    const { data: stuckDailyCycles } = await sb.from("did_update_cycles")
      .select("id, started_at, heartbeat_at, phase")
      .eq("cycle_type", "daily")
      .eq("status", "running")
      .or(`heartbeat_at.lt.${stuckCutoff},and(heartbeat_at.is.null,started_at.lt.${stuckCutoff})`);
    if (stuckDailyCycles && stuckDailyCycles.length > 0) {
      for (const stuck of stuckDailyCycles) {
        await sb.from("did_update_cycles").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          last_error: `stuck_no_heartbeat_${STUCK_WINDOW_MIN}min(phase=${(stuck as any).phase || "unknown"})`,
        }).eq("id", stuck.id);
      }
      console.log(`[daily-cycle] Auto-cleanup: ${stuckDailyCycles.length} stuck daily cycles marked failed (window=${STUCK_WINDOW_MIN}min)`);
    }

    // 2) CONCURRENCY GUARD podle freshness, ne podle started_at.
    //    LIVE = heartbeat_at >= cutoff  OR  (heartbeat_at IS NULL AND started_at >= cutoff)
    //    Healthy long-running cycle (běží 2h, ale heartbeat-uje) je stále LIVE → blokuje nový run.
    const { data: runningDailyCycle } = await sb.from("did_update_cycles")
      .select("id, started_at, heartbeat_at, phase")
      .eq("cycle_type", "daily")
      .eq("status", "running")
      .or(`heartbeat_at.gte.${stuckCutoff},and(heartbeat_at.is.null,started_at.gte.${stuckCutoff})`)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runningDailyCycle) {
      console.log(`[daily-cycle] Already running (live): cycle ${runningDailyCycle.id} since ${runningDailyCycle.started_at}, hb=${runningDailyCycle.heartbeat_at}, phase=${(runningDailyCycle as any).phase}, skipping.`);
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: "already_running",
        cycleId: runningDailyCycle.id,
        liveDefinition: "coalesce(heartbeat_at, started_at) >= now() - 30min",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const cycleInsertPayload: any = { cycle_type: "daily", status: "running" };
    if (resolvedUserId) cycleInsertPayload.user_id = resolvedUserId;
    const { data: cycle, error: cycleErr } = await sb.from("did_update_cycles").insert(cycleInsertPayload).select().single();
    if (cycleErr) console.error("[daily-cycle] Failed to create cycle record:", cycleErr.message);
    cycleId = cycle?.id || null;

    // ─── HEARTBEAT HELPER (E1) ────────────────────────────────────────────
    // Zapisuje phase + heartbeat_at na začátku každé hlavní fáze daily-cycle.
    // Slouží jako důkaz živosti pro stuck cleanup (E3) i pro diagnostiku
    // toho, ve které fázi cycle případně visí.
    const setPhase = async (phase: string, detail = "") => {
      if (!cycleId) return;
      try {
        await sb.from("did_update_cycles").update({
          phase,
          phase_detail: detail.slice(0, 500),
          heartbeat_at: new Date().toISOString(),
        }).eq("id", cycleId);
      } catch (e) {
        console.warn(`[daily-cycle] setPhase("${phase}") failed:`, (e as Error)?.message || e);
      }
    };

    // ─── PER-CALL TIMEOUT GUARD (audit_0b hardening) ──────────────────────
    // Obal libovolné async operace timeoutem. Při překročení vyhodí
    // `TimeoutError`, který volající chytá a pokračuje (safe continue).
    // Default 60 s odpovídá nejdelší pozorované zdravé Drive operaci
    // s rezervou; vše nad 60 s je v praxi zaseknutý call, ne pomalý call.
    const withTimeout = async <T,>(label: string, ms: number, op: () => Promise<T>): Promise<T> => {
      let timer: number | undefined;
      try {
        return await Promise.race([
          op(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(`TimeoutError: ${label} exceeded ${ms}ms`);
              (err as any).name = "TimeoutError";
              (err as any).isTimeout = true;
              (err as any).label = label;
              reject(err);
            }, ms) as unknown as number;
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const AUDIT_DRIVE_TIMEOUT_MS = 60_000;
    await setPhase("normalize_cards", "Fáze 2: Normalizace struktury karet A–M");

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
    let cardFatalErrors = 0;

    // ═══ CRITICAL PHASE STATUS — fail-closed tracking for is_processed guard ═══
    const criticalPhaseStatus = {
      therapistIntelligenceOk: false,
      dashboardOk: false,
      operativePlanOk: false,
      queueFlushTriggeredOk: false,
      cardPipelineOk: false,
    };
    let finalReportText = "";
    let aiReportText = "";
    let hankaHtml = "";
    let kataHtml = "";

    await setPhase("audit_0b_start", "Fáze 0B: Audit struktury karet");
    // ═══ KROK 0B – AUDIT STRUKTURY KARTY PŘED ZPRACOVÁNÍM ═══
    // Povinný krok: pro každé nezpracované vlákno audituje strukturu odpovídající karty
    // Handles: Case 1 (missing sections), Case 2 (malformed structure), Case 3 (STUB promotion), Case 4 (no card exists)
    const auditResults: AuditResult[] = [];
    const auditAlerts: string[] = []; // ⚠️ alerts for Hanka's daily report
    if (folderId && registryContext && threads.length > 0) {
      // Memory-safe: audit max 1 card per run to avoid memory limit crashes
      const MAX_AUDIT_PER_RUN = 1;
      console.log(`[KROK-0B] Starting structural audit for ${threads.length} thread(s), max ${MAX_AUDIT_PER_RUN} card(s) per run...`);
      const auditedParts = new Set<string>();
      let auditCount = 0;

      for (const thread of threads) {
        if (auditCount >= MAX_AUDIT_PER_RUN) {
          console.log(`[KROK-0B] Memory guard: skipping remaining audits (${auditCount}/${MAX_AUDIT_PER_RUN} done)`);
          break;
        }
        if ((thread.sub_mode || "cast") !== "cast") continue;
        const partName = normalizePartHint(thread.part_name || "");
        if (!partName || auditedParts.has(canonicalText(partName))) continue;
        auditedParts.add(canonicalText(partName));
        auditCount++;

        try {
          // ─── substep: resolveCardTarget ───
          await setPhase("audit_0b_resolve", `part="${partName}"`);
          let target;
          try {
            target = await withTimeout(
              `resolveCardTarget(${partName})`,
              AUDIT_DRIVE_TIMEOUT_MS,
              () => resolveCardTarget(token, folderId, partName, registryContext!),
            );
          } catch (e) {
            const isTo = (e as any)?.isTimeout === true;
            console.warn(`[KROK-0B] ${isTo ? "TIMEOUT" : "ERROR"} resolveCardTarget for "${partName}":`, (e as Error)?.message || e);
            await setPhase("audit_0b_resolve_skip", `part="${partName}" reason=${isTo ? "timeout" : "error"}`);
            auditAlerts.push(`⚠️ Audit přeskočen pro "${partName}" – ${isTo ? "timeout" : "chyba"} při resolveCardTarget.`);
            continue;
          }
          const lookupName = target.registryEntry?.name || partName;

          if (!target.registryEntry) {
            // ═══ Case 4: Part has NO registry entry AND no card → create new card ═══
            console.log(`[KROK-0B] "${partName}": mimo registr – vytvářím novou kartu (Case 4)`);
            if (registryContext.activeFolderId) {
              await setPhase("audit_0b_create", `part="${partName}" case=4`);
              try {
                const result = await withTimeout(
                  `createNewCardForPart(${partName})`,
                  AUDIT_DRIVE_TIMEOUT_MS,
                  () => createNewCardForPart(
                    token, partName,
                    Array.isArray(thread.messages) ? thread.messages as any[] : [],
                    registryContext!.activeFolderId!,
                    registryContext!,
                  ),
                );
                auditResults.push(result);
                cardsUpdated.push(`${partName} (AUDIT-0B: NOVÁ KARTA – ${result.created ? "vytvořena" : "chyba"})`);
                if (result.alertForHanka) {
                  auditAlerts.push(result.alertForHanka);
                }
              } catch (e) {
                const isTo = (e as any)?.isTimeout === true;
                console.error(`[KROK-0B] ${isTo ? "TIMEOUT" : "ERROR"} Case 4 createNewCardForPart for "${partName}":`, (e as Error)?.message || e);
                await setPhase("audit_0b_create_skip", `part="${partName}" case=4 reason=${isTo ? "timeout" : "error"}`);
                auditAlerts.push(`⚠️ Karta nevytvořena pro "${partName}" – ${isTo ? "timeout" : "chyba"} při createNewCardForPart.`);
              }
            }
            continue;
          }

          // ─── substep: findCardFile ───
          await setPhase("audit_0b_find", `part="${lookupName}"`);
          let card;
          try {
            card = await withTimeout(
              `findCardFile(${lookupName})`,
              AUDIT_DRIVE_TIMEOUT_MS,
              () => findCardFile(token, lookupName, target.searchRootId),
            );
          } catch (e) {
            const isTo = (e as any)?.isTimeout === true;
            console.warn(`[KROK-0B] ${isTo ? "TIMEOUT" : "ERROR"} findCardFile for "${lookupName}":`, (e as Error)?.message || e);
            await setPhase("audit_0b_find_skip", `part="${lookupName}" reason=${isTo ? "timeout" : "error"}`);
            auditAlerts.push(`⚠️ Audit přeskočen pro "${lookupName}" – ${isTo ? "timeout" : "chyba"} při findCardFile.`);
            continue;
          }

          if (card) {
            // Cases 1, 2, 3: Audit existing card structure
            const hasThreadMsgs = Array.isArray(thread.messages) && (thread.messages as any[]).filter((m: any) => m?.role === "user").length >= 2;
            await setPhase("audit_0b_struct", `part="${lookupName}"`);
            // ─── HEARTBEAT KEEP-ALIVE during long Drive call ────────────────
            // Daily-cycle watchdog kills runs whose heartbeat_at is older than
            // STUCK_WINDOW_MIN. A single auditCardStructure() call can take up
            // to AUDIT_DRIVE_TIMEOUT_MS (60s) PLUS Drive read jitter; running
            // 20+ cards in a row without intermediate heartbeats can push the
            // gap past 30 min if any single card is slow. Tick every 60s so
            // the cycle stays visibly alive even when this single sub-step
            // takes longer than expected. Cleared in finally to avoid leaks.
            let keepAliveTimer: number | undefined;
            try {
              keepAliveTimer = setInterval(() => {
                // fire-and-forget: best-effort heartbeat, errors swallowed inside setPhase
                void setPhase("audit_0b_struct_keepalive", `part="${lookupName}"`);
              }, 60_000) as unknown as number;
              const result = await withTimeout(
                `auditCardStructure(${lookupName})`,
                AUDIT_DRIVE_TIMEOUT_MS,
                () => auditCardStructure(token, card.fileId, card.fileName, card.mimeType, lookupName, hasThreadMsgs),
              );
              auditResults.push(result);
              if (result.oversized) {
                await setPhase("audit_0b_struct_skip", `part="${lookupName}" reason=oversized bytes=${result.byteLength ?? "?"}`);
              }
              if (result.changes.length > 0) {
                cardsUpdated.push(`${lookupName} (AUDIT-0B: ${result.changes.length} oprav${result.promoted ? ", STUB→PLNÁ" : ""})`);
              }
              if (result.alertForHanka) {
                auditAlerts.push(result.alertForHanka);
              }
            } catch (e) {
              const isTo = (e as any)?.isTimeout === true;
              console.warn(`[KROK-0B] ${isTo ? "TIMEOUT" : "ERROR"} auditCardStructure for "${lookupName}":`, (e as Error)?.message || e);
              await setPhase("audit_0b_struct_skip", `part="${lookupName}" reason=${isTo ? "timeout" : "error"}`);
              auditAlerts.push(`⚠️ Strukturální audit přeskočen pro "${lookupName}" – ${isTo ? "timeout" : "chyba"} při auditCardStructure.`);
              continue;
            } finally {
              if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
            }
          } else {
            // ═══ Case 4b: Registry entry exists but no card file found → create card ═══
            console.log(`[KROK-0B] "${lookupName}": v registru ale karta nenalezena – vytvářím (Case 4b)`);
            if (registryContext.activeFolderId) {
              await setPhase("audit_0b_create", `part="${lookupName}" case=4b`);
              try {
                const result = await withTimeout(
                  `createNewCardForPart(${lookupName})`,
                  AUDIT_DRIVE_TIMEOUT_MS,
                  () => createNewCardForPart(
                    token, lookupName,
                    Array.isArray(thread.messages) ? thread.messages as any[] : [],
                    registryContext!.activeFolderId!,
                    registryContext!,
                  ),
                );
                auditResults.push(result);
                cardsUpdated.push(`${lookupName} (AUDIT-0B: KARTA VYTVOŘENA – chyběla na Drive)`);
                if (result.alertForHanka) {
                  auditAlerts.push(result.alertForHanka);
                }
              } catch (e) {
                const isTo = (e as any)?.isTimeout === true;
                console.error(`[KROK-0B] ${isTo ? "TIMEOUT" : "ERROR"} Case 4b createNewCardForPart for "${lookupName}":`, (e as Error)?.message || e);
                await setPhase("audit_0b_create_skip", `part="${lookupName}" case=4b reason=${isTo ? "timeout" : "error"}`);
                auditAlerts.push(`⚠️ Karta nevytvořena pro "${lookupName}" – ${isTo ? "timeout" : "chyba"} při createNewCardForPart.`);
              }
            }
          }
        } catch (e) {
          console.warn(`[KROK-0B] Audit error for "${partName}":`, e);
          await setPhase("audit_0b_error", `part="${partName}" reason=${(e as Error)?.message?.slice(0,120) || "unknown"}`);
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

    await setPhase("post_audit", `Po auditu: threads=${threads.length}, conv=${conversations.length}, allRecentThreads=${allRecentThreads.length}, allRecentConv=${allRecentConversations.length}`);

    // Use allRecentThreads for report generation, but threads (unprocessed) for card updates
    const hasRecentActivity = allRecentThreads.length > 0 || allRecentConversations.length > 0 || recentHanaConversations.length > 0 || recentClientSessions.length > 0 || recentCrisisBriefs.length > 0 || researchThreads.length > 0 || recentClientTasks.length > 0 || recentMeetings.length > 0 || recentEpisodes.length > 0;

    await setPhase("activity_check", `hasRecentActivity=${hasRecentActivity}, decision=${(threads.length === 0 && conversations.length === 0 && !hasRecentActivity) ? "quiet_day_branch" : "full_analysis_branch"}`);

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

    await setPhase("compile_data", "Fáze 3: Sběr a komprimace vláken/konverzací");
    // ─── KEEP-ALIVE: Phase 3 (compile_data) iterates over many Drive folders
    // (00_CENTRUM flat docs, 05_PLAN, 06_INTERVENCE, 07_DOHODY, individual
    // part cards) with sequential readFileContent / listFilesInFolder calls.
    // Without a periodic heartbeat the cleanup-watcher (E3) can mark the run
    // stuck mid-flight (observed: 74a1ed4d died after 10s). Tick every 45s;
    // cleared in the matching finally below before Phase 3b begins.
    let compileDataKeepAlive: number | undefined = setInterval(() => {
      void setPhase("compile_data_keepalive", "Fáze 3: čtu Drive (CENTRUM/karty/dohody)");
    }, 45_000) as unknown as number;
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

    // ─── CLEAR Phase 3 keep-alive before Phase 3b ─────────────────────────
    if (compileDataKeepAlive !== undefined) {
      clearInterval(compileDataKeepAlive);
      compileDataKeepAlive = undefined;
    }

    await setPhase("ai_analysis", "Fáze 3b: AI analýza A–M");
    // 3. AI ANALÝZA – full A-M decomposition
    const existingCardsContext = Object.entries(existingCards).map(([name, content]) =>
      `=== EXISTUJÍCÍ KARTA: ${name} ===\n${content.length > 3000 ? `${content.slice(0, 3000)}…` : content}`
    ).join("\n\n");

    let perplexityContext = "";
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (PERPLEXITY_API_KEY && allSummaries.trim().length > 40) {
      // ═══ RESEARCH SCHEDULING: Decide whether to call Perplexity today ═══
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0=Sunday
      const isResearchDay = dayOfWeek === 0; // Sunday = batch research day

      // Check for 🔍 REŠERŠE POTŘEBA tags in existing cards
      const researchNeedParts = new Set<string>();
      for (const [cardName, cardContent] of Object.entries(existingCards)) {
        if (cardContent.includes("REŠERŠE POTŘEBA")) {
          researchNeedParts.add(cardName);
        }
      }

      // Check for active crises
      let crisisPartNamesForResearch: string[] = [];
      try {
        const { data: activeCrisesForResearch } = await sb
          .from("crisis_events")
          .select("part_name")
          .not("phase", "eq", "closed");
        crisisPartNamesForResearch = (activeCrisesForResearch || []).map(c => c.part_name);
      } catch {}

      const shouldResearchNow = isResearchDay
        || researchNeedParts.size > 0
        || crisisPartNamesForResearch.length > 0;

      if (shouldResearchNow) {
        try {
          const perplexityPrompt = allSummaries.length > 7000 ? `${allSummaries.slice(0, 7000)}…` : allSummaries;

          // ═══ CACHE CHECK: Look for recent matching research ═══
          const queryWords = perplexityPrompt.toLowerCase().replace(/[^\wěščřžýáíéúůďťňó]/g, " ").split(/\s+/).filter(w => w.length > 3);
          let cacheHit = false;

          if (resolvedUserId) {
            const cacheCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: cachedResults } = await sb
              .from("did_research_cache")
              .select("query, result, citations, created_at")
              .eq("user_id", resolvedUserId)
              .gte("created_at", cacheCutoff)
              .order("created_at", { ascending: false })
              .limit(10);

            if (cachedResults && cachedResults.length > 0) {
              for (const cached of cachedResults) {
                const cachedWords = cached.query.toLowerCase().replace(/[^\wěščřžýáíéúůďťňó]/g, " ").split(/\s+/).filter((w: string) => w.length > 3);
                const overlap = queryWords.filter(w => cachedWords.includes(w)).length;
                const similarity = queryWords.length > 0 ? overlap / queryWords.length : 0;

                if (similarity >= 0.6) {
                  console.log(`[CACHE HIT] Používám uloženou rešerši z ${cached.created_at} (shoda ${Math.round(similarity * 100)}%)`);
                  perplexityContext = `\n\n═══ REŠERŠNÍ KONTEXT (cache z ${cached.created_at.slice(0, 10)}) ═══\n${cached.result}`;
                  if (cached.citations && cached.citations.length > 0) {
                    perplexityContext += `\n\nCitace:\n${cached.citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}`;
                  }
                  cacheHit = true;
                  break;
                }
              }
            }
          }

          if (!cacheHit) {
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

                // ═══ SAVE TO CACHE ═══
                if (resolvedUserId) {
                  const tags = queryWords.slice(0, 5);
                  try {
                    await sb.from("did_research_cache").insert({
                      user_id: resolvedUserId,
                      part_name: "_daily_cycle",
                      query: perplexityPrompt.slice(0, 2000),
                      result: text,
                      citations: citations,
                      tags: tags,
                    });
                    console.log(`[CACHE SAVE] Rešerše uložena do did_research_cache (${tags.length} tagů)`);
                  } catch (cacheErr) {
                    console.warn("[CACHE SAVE] Failed to save research cache:", cacheErr);
                  }
                }
              }
            } else {
              console.warn(`[perplexity] API error ${pRes.status}: ${(await pRes.text()).slice(0, 400)}`);
            }
          }
        } catch (e) {
          console.warn("[perplexity] Rešerše selhala:", e);
        }
      } else {
        console.log(`[RESEARCH SKIP] Not research day (${dayOfWeek}), no crisis, no 🔍 tags – skipping Perplexity`);
      }
    }

    // ─── KEEP-ALIVE: Phase 3b AI gateway call can take 60–120s. Without
    // a periodic heartbeat the cleanup-watcher (E3) sees stale heartbeat_at
    // and marks the cycle stuck mid-flight. Tick every 45s; cleared in finally.
    let aiAnalysisKeepAlive: number | undefined;
    aiAnalysisKeepAlive = setInterval(() => {
      void setPhase("ai_analysis_keepalive", "Fáze 3b: čekám na AI gateway");
    }, 45_000) as unknown as number;
    const analysisController = new AbortController();
    const analysisTimeout = setTimeout(() => analysisController.abort(), 120000);
    let analysisResponse: Response;
    try {
    analysisResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      signal: analysisController.signal,
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: SYSTEM_RULES + `\n\n═══ TEMPORÁLNÍ KONTEXT ═══
DNEŠNÍ DATUM: ${new Date().toISOString().slice(0, 10)}. Události starší 5 dnů považuj za HISTORICKÉ a NEUVÁDĚJ je jako aktuální. Pokud nemáš čerstvé informace (žádné vlákna/sezení za 72h), EXPLICITNĚ to uveď: "Naposledy jsem měl informace před X dny. Od té doby nemám aktualizaci." NIKDY nevydávej zastaralé události za aktuální (např. "zítra se vrátí z Jeseníků" pokud se to stalo před týdnem).

═══ ROLE GUARD ═══
Karel NIKDY neúkoluje terapeutky přípravou materiálů, plánů, technik ani analytickou prací. V úkolech pro terapeutky (tasks_for_hana, tasks_for_kata) POUZE: potvrdit účast, sdělit pozorování, odpovědět na otázku, provést konkrétní intervenci při sezení. ZAKÁZANÉ: "Připrav scénář", "Sestav plán", "Projdi si kartu", "Vymysli techniku", "Připrav 3 věty".

Jsi Karel – analytik DID systému a terapeutický supervizor. Zpracuj data z rozhovorů a rozlož KAŽDOU informaci do správných sekcí karet částí.

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

SEKCE B – Charakter a psychologický profil [REŽIM: DEEPEN]

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

→ Použij [SEKCE:B:DEEPEN] – piš POUZE nové poznatky (viz pravidla DEEPEN níže).

SEKCE C – Jádrové potřeby, strachy, triggery, konflikty, rizika [REŽIM: DEEPEN]

Pro KAŽDÝ odstavec (potřeby, strachy, triggery, konflikty, rizika):
1. Zhodnoť, který z bodů nejméně odpovídá (je nejvíce v rozporu) s projevem ve vlákně
2. Tento bod odstraň a nahraď novým, který celek doplňuje relevantně
3. Pokud vlákno přináší NOVÝ prvek (nový strach, trigger): přidej jako nový bod
4. Pokud prvek je na ústupu: přidej poznámku "Indicie z [datum]: tento prvek je momentálně na ústupu"
5. Pokud se část explicitně zmiňuje, že se něčeho už nebojí: přidej poznámku k danému bodu

→ Použij [SEKCE:C:DEEPEN] – piš POUZE nové poznatky (viz pravidla DEEPEN níže).

SEKCE D – Terapeutická doporučení a metody [REŽIM: DEEPEN]

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

→ Použij [SEKCE:D:DEEPEN] – piš POUZE nové poznatky (viz pravidla DEEPEN níže).

═══ ZNAČKA REŠERŠE POTŘEBA (pouze v sekci D) ═══
Pokud při analýze části narazíš na situaci, stav nebo potřebu, pro kterou NEMÁŠ v kartě vhodnou metodu/aktivitu/terapeutický postup, přidej na konec sekce D značku:
🔍 REŠERŠE POTŘEBA: [stručný popis co hledat]
Příklady:
🔍 REŠERŠE POTŘEBA: metody stabilizace pro dětskou část po noční můře (věk 5-7)
🔍 REŠERŠE POTŘEBA: techniky pro práci s protektorem který odmítá komunikaci
Tuto značku přidej POUZE pokud v sekci D a v existujících datech OPRAVDU chybí vhodný postup. Nepřidávej ji zbytečně.

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

SEKCE N – Karlův plán příštího sezení [REŽIM: REPLACE]

Pro každou část která byla dnes AKTIVNÍ (komunikovala, měla sezení, nebo je v krizi) vygeneruj KONKRÉTNÍ plán příštího sezení.

Formát:
📋 PLÁN SEZENÍ — {datum příštího sezení nebo 'NEJBLIŽŠÍ MOŽNÉ'}
👩‍⚕️ DOPORUČENÝ TERAPEUT: {Hanka/Káťa/obě} — důvod
🎯 CÍL SEZENÍ: {1 věta — co chceme dosáhnout}

POSTUP (krok za krokem):
1. ZAHÁJENÍ (5 min): {jak začít, jak navázat kontakt s částí, jaký tón, co říct}
2. HLAVNÍ AKTIVITA (15-25 min): {konkrétní metoda/technika/aktivita — NE obecně 'pracovat na traumatu' ale PŘESNĚ co dělat, např. 'kresba bezpečného místa s popisem kdo tam smí a kdo ne'}
3. ZÁLOŽNÍ PLÁN: {pokud část odmítne nebo se stáhne — co dělat místo toho}
4. UZAVŘENÍ (5 min): {jak ukončit, grounding technika, co říct na rozloučenou}

⚠️ POZOR: {specifická rizika pro tuto část při tomto sezení — triggery, čemu se vyhnout}
📊 MĚŘITELNÝ VÝSLEDEK: {jak poznat že sezení bylo úspěšné — konkrétní indikátor}
🔗 NÁVAZNOST: {jak toto sezení souvisí s dlouhodobým cílem z operativního plánu}

PRAVIDLA pro sekci N:
- REPLACE režim — vždy aktuální plán
- Generuj POUZE pro části které jsou aktivní nebo v krizi
- Metody/aktivity MUSÍ být konkrétní (ne 'terapeutická práce' ale 'technika bezpečného kontejneru s vizualizací')
- Pokud nemáš vhodnou metodu → přidej 🔍 REŠERŠE POTŘEBA do sekce D
- HLAVNÍ AKTIVITA musí vycházet z: aktuálního stavu části (sekce A), existujících doporučení (sekce D), aktivních cílů (sekce J), Perplexity rešerše (pokud proběhla)
- U částí v KRIZI: plán musí být STABILIZAČNÍ (ne explorační/integrační)

→ Použij [SEKCE:N:REPLACE] – vygeneruj KOMPLETNÍ plán příštího sezení.

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
[SEKCE:B:DEEPEN] pouze nové poznatky pro sekci B
[SEKCE:C:DEEPEN] pouze nové poznatky pro sekci C
[SEKCE:D:DEEPEN] pouze nové poznatky pro sekci D
[SEKCE:E] nový append záznam
[SEKCE:F:REPLACE] kompletní nová sekce F
[SEKCE:G] zápis do deníku (POUZE na žádost části!)
[SEKCE:H] nový append záznam
[SEKCE:I] nové terapeutické aktivity
[SEKCE:J:REPLACE] kompletní nová sekce J
[SEKCE:K] signifikantní jev (pokud existuje)
[SEKCE:L:REPLACE] kompletní nová sekce L
[SEKCE:M:REPLACE] kompletní nová sekce M
[SEKCE:N:REPLACE] plán příštího sezení (POUZE pro aktivní/krizové části)
[/KARTA]

Režimy zápisu:
- [SEKCE:X:REPLACE] = celá sekce se PŘEPÍŠE novým obsahem (Karel generuje KOMPLETNÍ sekci)
- [SEKCE:X:ROTATE] = sekce se inteligentně sloučí (Karel už provedl rotaci bodů)
- [SEKCE:X:DEEPEN] = NEMAŽ existující obsah, přidej POUZE nové poznatky na konec (oddělené ---). Pokud poznatek POTVRZUJE existující, přidej ✓ datum. Pokud ODPORUJE, přidej ⚡REVIZE. Pokud nemáš nic nového, VYNECH sekci.
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
    clearTimeout(analysisTimeout);
    if (aiAnalysisKeepAlive !== undefined) { clearInterval(aiAnalysisKeepAlive); aiAnalysisKeepAlive = undefined; }
    } catch (abortErr: any) {
      clearTimeout(analysisTimeout);
      if (aiAnalysisKeepAlive !== undefined) { clearInterval(aiAnalysisKeepAlive); aiAnalysisKeepAlive = undefined; }
      if (abortErr?.name === "AbortError") {
        console.error("[AI analysis] TIMEOUT after 120s — continuing with empty analysis");
        await setPhase("ai_analysis_timeout", "Phase 3b AI gateway timeout 120s");
        analysisResponse = new Response("", { status: 408 });
      } else {
        throw abortErr;
      }
    }

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

    await setPhase("update_cards", "Fáze 4: Aktualizace karet (async enqueue)");
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4 — ASYNC ENQUEUE ARCHITECTURE (replaces monolithic Drive writes)
    // ═══════════════════════════════════════════════════════════════════════
    // Historie:
    //   v1: synchronní updateCardSections per-part (selhával na ~150–250s wall-clock)
    //   v2: time-budget cut + skip (failed: jediná pomalá iterace zabila isolate)
    //   v3 (TADY): enqueue do existující did_pending_drive_writes + reuse
    //              karel-drive-queue-processor pro skutečné Drive writes
    //
    // Cíl: daily-cycle už NEČEKÁ na Drive I/O. Jen vyrobí update intents,
    //      zapíše je do queue a okamžitě pokračuje do fází 5–10.
    //
    // Trade-off: per-section MERGE/DEEPEN (čtení existujícího obsahu před
    //   zápisem) se v této async verzi NEDĚLÁ. Processor je strict append.
    //   Karta tedy dostane `[SEKCE:X]\nobsah\n[SEKCE:Y]\nobsah` jako jeden
    //   append blok s timestamp headerem. Restrukturalizační/dedup pass je
    //   future work (out of scope tohoto orchestration fixu).
    // ═══════════════════════════════════════════════════════════════════════

    const cardsEnqueued: string[] = [];      // Successfully enqueued card targets
    const cardsDeferred: string[] = [];       // Skipped (blacklist / no registry / hallucinated)
    const centrumEnqueued: string[] = [];     // Centrum doc enqueues
    let cardEnqueueErrors = 0;

    const enqueueDriveWrite = async (params: {
      target_document: string;
      payload: string;
      write_type: "append" | "replace";
      priority?: "critical" | "urgent" | "high" | "normal" | "low";
      content_type: string;
      subject_type: string;
      subject_id: string;
      source_id?: string;
    }): Promise<boolean> => {
      try {
        const envelope = encodeGovernedWrite(params.payload, {
          source_type: "karel-did-daily-cycle",
          source_id: params.source_id || (cycle?.id ?? `daily-cycle-${Date.now()}`),
          content_type: params.content_type,
          subject_type: params.subject_type,
          subject_id: params.subject_id,
        });
        const insertPayload: Record<string, unknown> = {
          target_document: params.target_document,
          content: envelope,
          write_type: params.write_type,
          priority: params.priority || "normal",
          status: "pending",
        };
        if (resolvedUserId) insertPayload.user_id = resolvedUserId;
        const { error } = await sb.from("did_pending_drive_writes").insert(insertPayload);
        if (error) {
          console.error(`[PHASE_4_ENQUEUE] insert error for ${params.target_document}:`, error.message);
          cardEnqueueErrors++;
          return false;
        }
        return true;
      } catch (e) {
        console.error(`[PHASE_4_ENQUEUE] enqueue failed for ${params.target_document}:`, e);
        cardEnqueueErrors++;
        return false;
      }
    };

    // ═══ BLACKLIST: Biologické osoby a terapeuti – NIKDY nevytvářet karty DID ═══
    const NON_DID_BLACKLIST = new Set([
      "amalka", "tonička", "tonicka", "jiří", "jiri", "jirka",
      "kata", "katka", "kája", "kaja", "káťa", "katya",
      "hanka", "hana", "hanička", "hanicka", "mamka",
      "holky", "holčičky", "holcicky", "děti", "deti", "malé", "male",
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
        const entry = findBestRegistryEntry(normalizedName, registryContext.entries);
        if (!entry && !isBlacklisted(normalizedName)) {
          const isKnownThreadPart = knownThreadParts.has(canonicalText(normalizedName));
          if (!isKnownThreadPart) {
            console.warn(`[ANTI-HALLUCINATION] ⛔ Rejected [KARTA:${rawName}] – not in registry`);
            blocksToRemove.push(m[0]);
          }
        }
      }
      for (const block of blocksToRemove) {
        filtered = filtered.replace(block, `<!-- REJECTED: hallucinated part -->`);
      }
      if (blocksToRemove.length > 0) {
        console.log(`[ANTI-HALLUCINATION] Removed ${blocksToRemove.length} hallucinated [KARTA:] blocks`);
      }
      return filtered;
    })();

    const phase4Start = Date.now();
    if (validatedAnalysisText) {
      const cardBlockRegex = /\[KARTA:(.+?)\]([\s\S]*?)\[\/KARTA\]/g;
      for (const match of validatedAnalysisText.matchAll(cardBlockRegex)) {
        const rawPartName = match[1].trim();
        const normalizedPartName = normalizePartHint(rawPartName);
        const cardBlock = match[2];

        // Blacklist filter
        if (isBlacklisted(normalizedPartName) || isBlacklisted(rawPartName)) {
          console.warn(`[BLACKLIST] ⛔ Skipped non-DID person: "${rawPartName}"`);
          cardsDeferred.push(`${rawPartName}:blacklisted`);
          continue;
        }

        // Registry guard – must exist in did_part_registry
        const registryEntry = registryContext
          ? findBestRegistryEntry(normalizedPartName, registryContext.entries)
          : null;
        if (!registryEntry) {
          console.warn(`[REGISTRY-GUARD] No registry entry for "${rawPartName}", skipping enqueue`);
          cardsDeferred.push(`${rawPartName}:no_registry_entry`);
          continue;
        }

        const resolvedPartName = registryEntry.name || normalizedPartName;
        if (isBlacklisted(resolvedPartName)) {
          cardsDeferred.push(`${resolvedPartName}:blacklisted_resolved`);
          continue;
        }

        // Parse sections to validate non-empty content
        const sectionRegex = /\[SEKCE:([A-N])(?::(\w+))?\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
        const newSections: Record<string, string> = {};
        const sectionModes: Record<string, string> = {};
        for (const sm of cardBlock.matchAll(sectionRegex)) {
          const letter = sm[1].toUpperCase();
          const mode = (sm[2] || "APPEND").toUpperCase();
          const content = sm[3].trim();
          if (content) {
            if (newSections[letter] && mode === "APPEND") {
              newSections[letter] += "\n\n" + content;
            } else {
              newSections[letter] = content;
              sectionModes[letter] = mode;
            }
          }
        }
        if (Object.keys(newSections).length === 0) {
          cardsDeferred.push(`${resolvedPartName}:no_sections`);
          continue;
        }

        // Compose append payload — processor will prepend timestamp header
        const sectionLetters = Object.keys(newSections).sort();
        const payloadLines: string[] = [];
        for (const letter of sectionLetters) {
          const mode = sectionModes[letter] || "APPEND";
          const tag = mode === "APPEND" ? `[SEKCE:${letter}]` : `[SEKCE:${letter}:${mode}]`;
          payloadLines.push(tag);
          payloadLines.push(newSections[letter]);
          payloadLines.push("");
        }
        const payload = payloadLines.join("\n").trimEnd();

        // ═══ Section N (next session plan) → DB write (rýchlé, žádný Drive call) ═══
        if (newSections["N"] && resolvedUserId) {
          try {
            await sb.from("did_part_registry")
              .update({ next_session_plan: newSections["N"], updated_at: new Date().toISOString() })
              .eq("part_name", resolvedPartName)
              .eq("user_id", resolvedUserId);
          } catch (nErr) {
            console.warn(`[section-N] Failed to save for "${resolvedPartName}":`, nErr);
          }
        }

        const driveTarget = `KARTA_${resolvedPartName.toUpperCase()}`;
        const enqueued = await enqueueDriveWrite({
          target_document: driveTarget,
          payload,
          write_type: "append",
          priority: "normal",
          content_type: "card_section_update",
          subject_type: "part",
          subject_id: resolvedPartName,
        });
        if (enqueued) {
          cardsEnqueued.push(`${resolvedPartName} [sections=${sectionLetters.join(",")}]`);
          cardsUpdated.push(`${resolvedPartName} (ENQUEUED: ${sectionLetters.join(",")})`);
          successfulCardUpdates.push({
            partName: resolvedPartName,
            fileName: driveTarget,
            sectionsUpdated: sectionLetters,
            pathLabel: "queue",
            actionType: "aktualizace" as CardActionType,
          });
        } else {
          cardsDeferred.push(`${resolvedPartName}:enqueue_error`);
          hadCardUpdateErrors = true;
        }
      }

      const phase4ElapsedMs = Date.now() - phase4Start;
      console.log(`[PHASE_4_ENQUEUE] ✅ Done in ${phase4ElapsedMs}ms — enqueued=${cardsEnqueued.length}, deferred=${cardsDeferred.length}, errors=${cardEnqueueErrors}`);

      criticalPhaseStatus.cardPipelineOk = cardEnqueueErrors === 0;
      console.log(`[PHASE_8] Card pipeline (async): enqueueErrors=${cardEnqueueErrors}, enqueued=${cardsEnqueued.length}, pipelineOk=${criticalPhaseStatus.cardPipelineOk}`);

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
      // ═══════════════════════════════════════════════════════════════════════
      // CENTRUM ENQUEUE — async write přes did_pending_drive_writes
      // Trade-off: vypouštíme synchronní KHASH/substring dedup čtení existujícího
      // dokumentu. U replace cest (05A/05B/dashboard) overwrite vyřeší duplicate
      // problém. U strategick_vyhled append je KHASH marker stále v payloadu.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const centrumBlockRegex = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
        const dateStr = new Date().toISOString().slice(0, 10);

        for (const match of validatedAnalysisText.matchAll(centrumBlockRegex)) {
          const docName = match[1].trim();
          let newContent = match[2].trim();
          if (!newContent || newContent.length < 10) continue;

          const docCanonical = canonicalText(docName);
          const isDashboardOrPlan = docCanonical.includes("dashboard") || docCanonical.includes("operativn") || docCanonical.includes("terapeutick");
          if (isDashboardOrPlan) {
            const { validated, rejectedCount, keptCount } = validateCentrumEvidence(newContent, validSources, docName);
            if (rejectedCount > 0) {
              console.log(`[EVIDENCE] ${docName}: ${rejectedCount} claims rejected, ${keptCount} validated`);
            }
            newContent = validated;
            if (newContent.trim().length < 10) {
              console.warn(`[EVIDENCE] ${docName}: All content rejected, skipping enqueue`);
              continue;
            }
          }

          try {
            // ── 05_Operativni_Plan / 05_Terapeuticky_Plan → REPLACE 05A ──
            if ((docCanonical.includes("operativn") && docCanonical.includes("plan")) || (docCanonical.includes("terapeutick") && docCanonical.includes("plan"))) {
              const planDocument = `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel (vedoucí terapeutického týmu)\n\n${newContent}`;
              therapeuticPlanContent = newContent;
              const ok = await enqueueDriveWrite({
                target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
                payload: planDocument,
                write_type: "replace",
                priority: "high",
                content_type: "daily_plan",
                subject_type: "system",
                subject_id: "operative_plan",
              });
              if (ok) {
                cardsUpdated.push(`CENTRUM: 05A_Operativni_Plan (ENQUEUED replace)`);
                centrumEnqueued.push("05A_OPERATIVNI_PLAN");
                centrumOperativniUpdated = true;
              }
              criticalPhaseStatus.operativePlanOk = centrumOperativniUpdated;
              console.log(`[PHASE_6] operativePlanOk=${criticalPhaseStatus.operativePlanOk} (enqueued)`);
              continue;
            }

            // ── 00_Aktualni_Dashboard → REPLACE DASHBOARD ──
            if (docCanonical.includes("dashboard")) {
              const dashDocument = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${newContent}`;
              const ok = await enqueueDriveWrite({
                target_document: "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
                payload: dashDocument,
                write_type: "replace",
                priority: "high",
                content_type: "dashboard_status",
                subject_type: "system",
                subject_id: "dashboard",
              });
              if (ok) {
                cardsUpdated.push(`CENTRUM: 00_Dashboard (ENQUEUED replace)`);
                centrumEnqueued.push("DASHBOARD");
                centrumDashboardUpdated = true;
              }
              criticalPhaseStatus.dashboardOk = centrumDashboardUpdated;
              console.log(`[PHASE_6] dashboardOk=${criticalPhaseStatus.dashboardOk} (enqueued)`);
              continue;
            }

            // ── 06_Strategicky_Vyhled → REPLACE 05B (governance allows replace) ──
            if (docCanonical.includes("strategick") && docCanonical.includes("vyhled")) {
              const hash = contentHash(newContent.trim());
              const stratDocument = `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr} [KHASH:${hash}]\nSprávce: Karel\n\n${newContent}`;
              const ok = await enqueueDriveWrite({
                target_document: "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
                payload: stratDocument,
                write_type: "replace",
                priority: "normal",
                content_type: "strategic_outlook",
                subject_type: "system",
                subject_id: "strategic_outlook",
              });
              if (ok) {
                cardsUpdated.push(`CENTRUM: 05B_Strategicky_Vyhled (ENQUEUED replace)`);
                centrumEnqueued.push("05B_STRATEGICKY_VYHLED");
              }
              continue;
            }

            // Other CENTRUM docs (dohody / unknown) → silently skip (out of governance)
            console.log(`[CENTRUM] Skipping non-governed document: "${docName}"`);
          } catch (e) {
            console.error(`[CENTRUM-ENQUEUE] Failed for "${docName}":`, e);
          }
        }
      }

      // ═══ FORCED CENTRUM FALLBACK (ASYNC ENQUEUE) ═══
      // Pre-fix history: synchronous listFilesInFolder + updateFileById +
      // verifyCentrumWrite blocked Phase 4 wall-clock (~150–250s). Now we
      // build deterministic content from DB and enqueue replace operations
      // into did_pending_drive_writes. The queue processor handles real
      // Drive writes; verification moves to queue/status-level proof.
      if (hasRecentActivity) {
        // Load registry data for deterministic content (DB-only, no Drive I/O)
        const registryParts = registryContext?.entries || [];
        const activeParts = registryParts.filter(e => !isArchivedFromRegistry(e));
        const sleepingParts = registryParts.filter(e => isArchivedFromRegistry(e));

        if (!centrumDashboardUpdated) {
          console.warn(`[CENTRUM-FALLBACK] AI did NOT generate [CENTRUM:00_Aktualni_Dashboard] – enqueuing FULL deterministic dashboard`);
          try {
            const dateStr = new Date().toISOString().slice(0, 10);
            const activePartsFromThreads = [...new Set(reportThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))];
            const therapistThreads = reportThreads.filter(t => t.sub_mode !== "cast");

            const partStatusLines = activeParts.map(p => {
              const hadActivity = activePartsFromThreads.some(tp => canonicalText(tp) === p.normalizedName);
              const status = hadActivity ? "🟢 komunikoval/a s Karlem" : "🟡 bez aktivity dnes";
              return `▸ ${p.name} (ID ${p.id}) [${status}] – klastr: ${p.cluster || "?"}, věk: ${p.age || "?"}`;
            });

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

            const sleepingWatchlist = sleepingParts.length > 0
              ? sleepingParts.map(p => `▸ ${p.name} (ID ${p.id}) – status: ${p.status}, klastr: ${p.cluster || "?"}`).join("\n")
              : "Žádné spící části v registru.";

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

            const ok = await enqueueDriveWrite({
              target_document: "KARTOTEKA_DID/00_CENTRUM/00_Aktualni_Dashboard",
              payload: fullDashboard,
              write_type: "replace",
              priority: "high",
              content_type: "centrum_fallback_dashboard",
              subject_type: "centrum",
              subject_id: "00_Aktualni_Dashboard",
            });
            if (ok) {
              centrumEnqueued.push("00_Aktualni_Dashboard (fallback)");
              cardsUpdated.push(`CENTRUM: 00_Dashboard (FALLBACK enqueued)`);
              centrumDashboardUpdated = true;
              criticalPhaseStatus.dashboardOk = true; // queue-level proof; processor verifies content
              console.log(`[CENTRUM-FALLBACK] ✅ Dashboard fallback enqueued (verification deferred to queue processor)`);
            }
          } catch (e) { console.error(`[CENTRUM-FALLBACK] Dashboard enqueue failed:`, e); }
        }

        if (!centrumOperativniUpdated) {
          console.warn(`[CENTRUM-FALLBACK] AI did NOT generate [CENTRUM:05_Operativni_Plan] – enqueuing FULL deterministic plan`);
          try {
            const dateStr = new Date().toISOString().slice(0, 10);
            const activePartsFromThreads = [...new Set(reportThreads.filter(t => t.sub_mode === "cast").map(t => t.part_name))];

            const partStatusTable = activeParts.map(p => {
              const hadActivity = activePartsFromThreads.some(tp => canonicalText(tp) === p.normalizedName);
              return `| ${p.name} / ${p.id} | ${hadActivity ? "Aktivní" : "Ticho"} | ${p.cluster || "?"} | ${p.age || "?"} |`;
            }).join("\n");

            const taskLines = (pendingTasks || []).map((t: any) => {
              const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
              const icon = age >= 3 ? "⚠️" : "☐";
              return `${icon} ${t.assigned_to}: ${t.task} (${age}d, ${t.priority || "normal"})`;
            }).join("\n") || "Žádné nesplněné úkoly.";

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
            const ok = await enqueueDriveWrite({
              target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
              payload: fullPlan,
              write_type: "replace",
              priority: "high",
              content_type: "centrum_fallback_operativni_plan",
              subject_type: "centrum",
              subject_id: "05A_OPERATIVNI_PLAN",
            });
            if (ok) {
              centrumEnqueued.push("05A_OPERATIVNI_PLAN (fallback)");
              cardsUpdated.push(`CENTRUM: 05_Operativni_Plan (FALLBACK enqueued)`);
              centrumOperativniUpdated = true;
              criticalPhaseStatus.operativePlanOk = true; // queue-level proof
              console.log(`[CENTRUM-FALLBACK] ✅ Operative plan fallback enqueued (verification deferred to queue processor)`);
            }
          } catch (e) { console.error(`[CENTRUM-FALLBACK] Operative plan enqueue failed:`, e); }
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

      // ═══ 07_KNIHOVNA ANALYSIS (BUDGETED + ASYNC ENQUEUE) ═══
      // Pre-fix history: blok dělal 2× listFilesInFolder + N× readFileContent
      // + AI call + N× sync updateFileById/appendToDoc → blokoval Phase 4.
      // Teď: hard time-budget guard (skip pokud Phase 4 elapsed > 60s),
      // a VŠECHNY zápisy jdou přes enqueueDriveWrite. Read-only Drive calls
      // zůstávají (jsou nutné pro AI analýzu příruček), ale jen pokud zbývá
      // čas; jinak se celý blok deferuje do dalšího runu.
      const KNIHOVNA_BUDGET_MS = 60_000;
      const knihovnaSkipReason = (Date.now() - phase4Start) > KNIHOVNA_BUDGET_MS
        ? `phase4_elapsed=${Date.now() - phase4Start}ms > ${KNIHOVNA_BUDGET_MS}ms`
        : !centrumFolderId
          ? "no_centrum_folder_id"
          : null;
      if (knihovnaSkipReason) {
        console.warn(`[knihovna] ⏭️  SKIPPED (${knihovnaSkipReason}) – deferred to next daily-cycle run`);
        cardsDeferred.push(`07_Knihovna:deferred:${knihovnaSkipReason}`);
      } else {
        try {
          const centerFiles = await listFilesInFolder(token, centrumFolderId!);
          const knihovnaFolder = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && f.name.includes("07_Knihovna"));

          if (knihovnaFolder) {
            const knihovnaFiles = await listFilesInFolder(token, knihovnaFolder.id);
            const prehledFile = knihovnaFiles.find(f => f.name.startsWith("00_Prehled"));

            if (prehledFile) {
              const prehledContent = await readFileContent(token, prehledFile.id);

              const handbookFiles = knihovnaFiles.filter(f =>
                f.mimeType !== DRIVE_FOLDER_MIME && !f.name.startsWith("00_Prehled")
              );

              let handbookContext = "";
              const undistributedHandbooks: Array<{ id: string; name: string }> = [];
              const MAX_HANDBOOK_CHARS = 2000;
              for (const hf of handbookFiles.slice(0, 10)) {
                // Re-check budget before EACH read; abort if exhausted
                if ((Date.now() - phase4Start) > KNIHOVNA_BUDGET_MS) {
                  console.warn(`[knihovna] Budget exhausted mid-read; stopping handbook scan`);
                  break;
                }
                try {
                  const hContent = await readFileContent(token, hf.id);
                  if (hContent.includes("[DISTRIBUOVÁNO DO KARTOTÉKY")) {
                    console.log(`[knihovna] Skipping already distributed: "${hf.name}"`);
                    continue;
                  }
                  handbookContext += `\n\n=== PŘÍRUČKA: ${hf.name} ===\n${hContent.length > MAX_HANDBOOK_CHARS ? hContent.slice(0, MAX_HANDBOOK_CHARS) + "…" : hContent}`;
                  undistributedHandbooks.push({ id: hf.id, name: hf.name });
                } catch {}
              }

              if (handbookContext.length > 100 && (Date.now() - phase4Start) <= KNIHOVNA_BUDGET_MS) {
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

                    // Process [KNIHOVNA_KARTA:...] → ENQUEUE per part (no sync Drive writes)
                    const kartaRegex = /\[KNIHOVNA_KARTA:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_KARTA\]/g;
                    for (const km of knihovnaText.matchAll(kartaRegex)) {
                      const partName = km[1].trim();
                      const block = km[2].trim();

                      if (isBlacklisted(partName)) continue;

                      const sectionRegex = /\[SEKCE:([A-N])\]\s*([\s\S]*?)(?=\[SEKCE:|$)/g;
                      const newSections: Record<string, string> = {};
                      for (const sm of block.matchAll(sectionRegex)) {
                        const content = sm[2].trim();
                        if (content) newSections[sm[1].toUpperCase()] = content;
                      }

                      if (Object.keys(newSections).length > 0) {
                        // Validate registry entry exists (no Drive I/O – uses cached registryContext)
                        const knihovnaEntry = registryContext
                          ? findBestRegistryEntry(normalizePartHint(partName), registryContext.entries)
                          : null;
                        if (!knihovnaEntry) {
                          console.warn(`[knihovna] No registry entry for "${partName}" – skipping enqueue`);
                          continue;
                        }
                        const dateHeader = `\n\n[${new Date().toISOString().slice(0, 10)}] Z 07_Knihovna (daily-cycle):\n`;
                        const sectionLetters = Object.keys(newSections).sort();
                        const payload = dateHeader + sectionLetters
                          .map(letter => `[SEKCE:${letter}]\n${newSections[letter]}`)
                          .join("\n\n");
                        const ok = await enqueueDriveWrite({
                          target_document: `KARTA_${(knihovnaEntry.name || partName).toUpperCase()}`,
                          payload,
                          write_type: "append",
                          priority: "normal",
                          content_type: "knihovna_card_section_update",
                          subject_type: "part",
                          subject_id: knihovnaEntry.name || partName,
                        });
                        if (ok) {
                          cardsEnqueued.push(`${partName} (z 07_Knihovna [sections=${sectionLetters.join(",")}])`);
                          cardsUpdated.push(`${partName} (z 07_Knihovna enqueued: ${sectionLetters.join(",")})`);
                          console.log(`[knihovna] ✅ Enqueued ${partName}: sections ${sectionLetters.join(",")}`);
                        }
                      }
                    }

                    // Process [KNIHOVNA_CENTRUM:...] → ENQUEUE append (no sync read-modify-write)
                    const centrumRegex = /\[KNIHOVNA_CENTRUM:(.+?)\]([\s\S]*?)\[\/KNIHOVNA_CENTRUM\]/g;
                    for (const cm of knihovnaText.matchAll(centrumRegex)) {
                      const docName = cm[1].trim();
                      const newContent = cm[2].trim();
                      if (!newContent || newContent.length < 10) continue;

                      // Map alias docName → canonical centrum doc target
                      const docCanonical = canonicalText(docName);
                      let canonicalTarget: string | null = null;
                      if (docCanonical.includes("dashboard")) canonicalTarget = "00_Aktualni_Dashboard";
                      else if (docCanonical.includes("dohod")) canonicalTarget = "05A_OPERATIVNI_PLAN"; // dohody folder → operativni plan
                      else if (docCanonical.includes("operativ")) canonicalTarget = "05A_OPERATIVNI_PLAN";
                      else if (docCanonical.includes("strateg") || docCanonical.includes("vyhled")) canonicalTarget = "05B_STRATEGICKY_VYHLED";
                      else if (docCanonical.includes("terapeutick") && docCanonical.includes("plan")) canonicalTarget = "05A_OPERATIVNI_PLAN";
                      if (!canonicalTarget) {
                        console.warn(`[knihovna] CENTRUM doc "${docName}" – no canonical mapping, skipping`);
                        continue;
                      }
                      const payload = `\n\n[${new Date().toISOString().slice(0, 10)}] Z 07_Knihovna:\n${newContent}`;
                      const ok = await enqueueDriveWrite({
                        target_document: `KARTOTEKA_DID/00_CENTRUM/${canonicalTarget}`,
                        payload,
                        write_type: "append",
                        priority: "normal",
                        content_type: "knihovna_centrum_append",
                        subject_type: "centrum",
                        subject_id: canonicalTarget,
                      });
                      if (ok) {
                        centrumEnqueued.push(`${canonicalTarget} (z 07_Knihovna)`);
                        cardsUpdated.push(`CENTRUM: ${docName} (z 07_Knihovna enqueued → ${canonicalTarget})`);
                        console.log(`[knihovna] ✅ CENTRUM ${canonicalTarget} enqueued from 07_Knihovna`);
                      }
                    }
                  }

                  // Mark distributed handbooks → ENQUEUE append marker (no sync appendToDoc)
                  const distribDateStr = new Date().toISOString().slice(0, 10);
                  for (const uh of undistributedHandbooks) {
                    const ok = await enqueueDriveWrite({
                      target_document: `KARTOTEKA_DID/00_CENTRUM/07_Knihovna/${uh.name}`,
                      payload: `\n\n[DISTRIBUOVÁNO DO KARTOTÉKY: ${distribDateStr}]`,
                      write_type: "append",
                      priority: "low",
                      content_type: "knihovna_distributed_marker",
                      subject_type: "knihovna_handbook",
                      subject_id: uh.id,
                    });
                    if (ok) console.log(`[knihovna] Distributed marker enqueued for "${uh.name}"`);
                  }
                } else {
                  console.warn(`[knihovna] AI analysis failed: ${knihovnaAnalysisRes.status}`);
                }
              } else if ((Date.now() - phase4Start) > KNIHOVNA_BUDGET_MS) {
                console.warn(`[knihovna] Budget exhausted before AI call – deferring`);
                cardsDeferred.push("07_Knihovna:budget_exhausted_pre_ai");
              }
            }
          }
        } catch (knihovnaErr) {
          console.warn("[knihovna] 07_Knihovna analysis error (non-fatal):", knihovnaErr);
        }
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
          .eq("user_id", resolvedUserId)
          .in("status", ["active", "warning"]);

        if (activeParts && activeParts.length > 0) {
          // Collect recent conversations per part
          const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: recentThreads } = await sb.from("did_threads")
            .select("part_name, messages, sub_mode")
            .eq("user_id", resolvedUserId)
            .gte("last_activity_at", cutoff7d)
            .order("last_activity_at", { ascending: false })
            .limit(50);

          // Get theme preferences
          const { data: themePrefs } = await sb.from("did_part_theme_preferences")
            .select("part_name, theme_preset, theme_config, chosen_at")
            .eq("user_id", resolvedUserId)
            .gte("chosen_at", cutoff7d);

          // Get existing profiles
          const { data: existingProfiles } = await sb.from("did_part_profiles")
            .select("*")
            .eq("user_id", resolvedUserId);

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
                    user_id: resolvedUserId,
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
              content: [
                `\u{1F4CB} **Karel svol\u00E1v\u00E1 poradu**\n`,
                `**T\u00E9ma:** ${meetingTopic}\n`,
                whyMatch?.[1]?.trim() ? `**Pro\u010D svol\u00E1v\u00E1m:** ${whyMatch[1].trim()}\n` : "",
                proposalMatch?.[1]?.trim() ? `**Co navrhuji:** ${proposalMatch[1].trim()}\n` : "",
                `**Hani\u010Dko:** Jak to vid\u00ED\u0161 ty? Co navrhuji\u0161?\n`,
                `**K\u00E1\u0165o:** Jak to vid\u00ED\u0161 ty? Co navrhuji\u0161?\n`,
                `\nO\u010Dek\u00E1v\u00E1m va\u0161e vyj\u00E1d\u0159en\u00ED \u2014 ka\u017Ed\u00E1 m\u016F\u017Ee odpov\u011Bd\u011Bt, a\u017E bude m\u00EDt \u010Das.`,
              ].filter(Boolean).join("\n"),
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
            await sendOrQueueEmail(sb!, {
              toEmail: MAMKA_EMAIL,
              toName: "Hanka",
              subject: `Karel – porada: ${meetingTopic}`,
              bodyHtml: emailHtml("Haničko"),
              emailType: "meeting_invite",
              fromAddress: "Karel <karel@hana-chlebcova.cz>",
            });
            await sendOrQueueEmail(sb!, {
              toEmail: KATA_EMAIL,
              toName: "Káťa",
              subject: `Karel – porada: ${meetingTopic}`,
              bodyHtml: emailHtml("Káťo"),
              emailType: "meeting_invite",
              fromAddress: "Karel <karel@hana-chlebcova.cz>",
            });
          }
        } catch (meetErr) {
          console.warn("[daily-cycle] Meeting auto-create error:", meetErr);
        }
      }
    } catch (meetingErr) {
      console.warn("[daily-cycle] Meeting detection error (non-fatal):", meetingErr);
    }

    // (Queue flush runs as PHASE_9 after all write-producing phases — see line ~6816)

    // ═══ ESCALATION LOGIC: 3-tier escalation for stale tasks (4/5/7 days) ═══
    try {
      const { data: allTasks } = await sb.from("did_therapist_tasks")
        .select("id, task, assigned_to, status, status_hanka, status_kata, created_at, escalation_level, category")
        .in("status", ["pending", "active", "in_progress", "not_started"]);

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
        .in("status", ["pending", "active", "in_progress", "not_started"]);

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
        context_data: {
          auditAlerts: auditAlerts.length > 0 ? auditAlerts : undefined,
          phase4: {
            mode: "async_enqueue_v3",
            elapsedMs: Date.now() - phase4Start,
            cardsEnqueuedCount: cardsEnqueued.length,
            cardsEnqueued: cardsEnqueued.length > 0 ? cardsEnqueued : undefined,
            cardsDeferredCount: cardsDeferred.length,
            cardsDeferred: cardsDeferred.length > 0 ? cardsDeferred : undefined,
            centrumEnqueuedCount: centrumEnqueued.length,
            centrumEnqueued: centrumEnqueued.length > 0 ? centrumEnqueued : undefined,
            enqueueErrors: cardEnqueueErrors,
          },
        },
      }).eq("id", cycle.id);
    }

    // shadowSync moved to standalone CRON — see karel-did-context-prime (runs daily at 5:30 UTC)

    await setPhase("revize_05ab", "Fáze 5: Denní revize 05A/05B");
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
                  { role: "system", content: SYSTEM_RULES + "\n\nJsi analytický asistent Karla. Extrahuj strukturovaná data z konverzací. Odpovídej POUZE ve formátu JSON." },
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
                    { role: "system", content: SYSTEM_RULES + "\n\nJsi analytický modul Karla (inspirovaný C.G. Jungem). Extrahuj profilová tvrzení z konverzací s klinickou přesností. Odpovídej POUZE JSON." },
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

    await setPhase("crisis_bridge", "Fáze 5.5: Bridge a vyhodnocení krizí");
    // ═══ FÁZE 5.5: BRIDGE crisis_alerts → crisis_events + VYHODNOCENÍ AKTIVNÍCH KRIZÍ ═══
    try {
      // ── BRIDGE: Sync crisis_alerts (System A) → crisis_events (System B) ──
      const { data: activeAlerts } = await sb
        .from("crisis_alerts")
        .select("*")
        .in("status", ["ACTIVE", "ACKNOWLEDGED"]);

      for (const alert of (activeAlerts || [])) {
        // Check if crisis_events record already exists for this part
        const { data: existingEvent } = await sb
          .from("crisis_events")
          .select("id")
          .eq("part_name", alert.part_name)
          .not("phase", "eq", "closed")
          .limit(1);

        if (!existingEvent || existingEvent.length === 0) {
          // Create bridge record in crisis_events
          await sb.from("crisis_events").insert({
            part_name: alert.part_name,
            phase: "acute",
            severity: alert.severity || "high",
            trigger_description: alert.summary || "Automaticky přemostěno z crisis_alerts",
            trigger_source: "crisis_alert_bridge",
            opened_at: alert.created_at || new Date().toISOString(),
          });
          console.log(`[BRIDGE] Created crisis_events for "${alert.part_name}" from crisis_alert ${alert.id}`);
        }
      }

      // ── PHASE TRANSITION: Analyze assessments and update crisis_events phases ──
      const { data: allOpenEvents } = await sb
        .from("crisis_events")
        .select("*")
        .not("phase", "eq", "closed");

      for (const event of (allOpenEvents || [])) {
        // Load last 5 assessments for this part
        const { data: recentAssessments } = await sb
          .from("crisis_daily_assessments")
          .select("karel_decision, karel_risk_assessment, part_emotional_state, part_risk_indicators, day_number")
          .eq("part_name", event.part_name)
          .order("assessment_date", { ascending: false })
          .limit(5);

        if (recentAssessments && recentAssessments.length >= 3) {
          const lastThree = recentAssessments.slice(0, 3);
          const decisions = lastThree.map((a: any) => a.karel_decision);
          const risks = lastThree.map((a: any) => a.karel_risk_assessment);
          const hasAnyCritical = risks.some((r: string) => r === "critical");
          const allImproving = decisions.every((d: string) => d === "crisis_improving");
          const allLowRisk = risks.every((r: string) => r === "low" || r === "minimal");
          const noRiskIndicators = lastThree.every((a: any) => {
            const indicators = a.part_risk_indicators;
            return !indicators || (Array.isArray(indicators) && indicators.length === 0);
          });

          let newPhase = event.phase;

          // Relapse detection: any critical after stabilization → reset to acute
          if (hasAnyCritical && event.phase !== "acute") {
            newPhase = "acute";
            console.log(`[PHASE TRANSITION] ${event.part_name}: RELAPSE → acute (critical risk detected)`);
          }
          // acute → stabilizing: 3+ days improving
          else if (event.phase === "acute" && allImproving) {
            newPhase = "stabilizing";
            console.log(`[PHASE TRANSITION] ${event.part_name}: acute → stabilizing (3 consecutive improving)`);
          }
          // stabilizing → diagnostic: 3+ days low risk + no risk indicators
          else if (event.phase === "stabilizing" && allLowRisk && noRiskIndicators) {
            newPhase = "diagnostic";
            console.log(`[PHASE TRANSITION] ${event.part_name}: stabilizing → diagnostic (3 days low risk, no indicators)`);
          }
          // diagnostic → closing: diagnostic score ≥ 65
          else if (event.phase === "diagnostic" && event.diagnostic_score && event.diagnostic_score >= 65) {
            newPhase = "closing";
            console.log(`[PHASE TRANSITION] ${event.part_name}: diagnostic → closing (score=${event.diagnostic_score})`);
          }

          if (newPhase !== event.phase) {
            await sb.from("crisis_events").update({
              phase: newPhase,
              updated_at: new Date().toISOString(),
            }).eq("id", event.id);
          }
        }
      }

      // ── Original crisis_events evaluation ──
      const { data: activeCrises } = await sb
        .from("crisis_events")
        .select("*")
        .not("phase", "eq", "closed");

      for (const crisis of (activeCrises || [])) {
        const daysActive = Math.ceil((Date.now() - new Date(crisis.opened_at).getTime()) / 86400000);
        await sb.from("crisis_events").update({ days_active: daysActive, updated_at: new Date().toISOString() }).eq("id", crisis.id);

        try {
          // Find matching crisis_alert for this crisis_event to get alert ID and part_id
          const { data: matchingAlert } = await sb
            .from("crisis_alerts")
            .select("id, part_name")
            .eq("part_name", crisis.part_name)
            .in("status", ["ACTIVE", "ACKNOWLEDGED"])
            .limit(1);
          const alertId = matchingAlert?.[0]?.id || crisis.id;

          const crisisMeetingMsgs = (recentMeetings || [])
            .filter((m: any) => (m.topic || "").toLowerCase().includes(crisis.part_name.toLowerCase()))
            .flatMap((m: any) => ((m.messages as any[]) || []).slice(-10))
            .map((msg: any) => `[${msg.author || msg.role || '?'}]: ${(msg.text || msg.content || '').slice(0, 300)}`)
            .join('\n')
            .slice(0, 2000);

          const evalUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-crisis-daily-assessment`;
          await fetch(evalUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ crisis_alert_id: alertId, part_id: crisis.id, part_name: crisis.part_name, meeting_context: crisisMeetingMsgs }),
          });
        } catch (e) { console.warn(`[daily-cycle] Crisis assessment error for ${crisis.part_name}:`, e); }
      }

      // Fallback escalation for long-running crises without recent action
      for (const crisis of (activeCrises || [])) {
        const daysActive = crisis.days_active || 0;
        if (daysActive >= 7) {
          const lastAction = crisis.diagnostic_date || crisis.updated_at;
          const daysSinceAction = lastAction
            ? Math.floor((Date.now() - new Date(lastAction).getTime()) / 86400000)
            : daysActive;

          if (daysSinceAction >= 3) {
            const escalationNote = `⚠️ ESKALACE ${new Date().toISOString().slice(0,10)}: `
              + `Krize "${crisis.trigger_description}" trvá ${daysActive} dní. `
              + `Poslední akce před ${daysSinceAction} dny. `
              + `VYŽADOVÁNA okamžitá pozornost: diagnostický rozhovor s částí, `
              + `konzultace s oběma terapeutkami, revize krizového plánu.`;

            const partName = crisis.part_name;
            if (partName) {
              // Write escalation to pending Drive writes (section J – priorities).
              // CASING: governance whitelist + Drive lookup expects KARTA_<UPPERCASE>.
              // WRITE_TYPE: processor only accepts 'append' | 'replace' — 'crisis_escalation'
              // would be silently skipped (write_type unsupported).
              await sb.from("did_pending_drive_writes").insert({
                target_document: `KARTA_${partName.toUpperCase()}`,
                content: `[SEKCE:J:REPLACE]\n${escalationNote}`,
                write_type: "append",
                priority: "urgent",
                user_id: resolvedUserId,
              });
            }

            console.log(`[CRISIS ESCALATION] ${partName}: ${daysActive} days active, ${daysSinceAction} days since last action – escalating`);
          }
        }
      }

      console.log(`[daily-cycle] Crisis eval: ${activeCrises?.length || 0} active crises`);

      // ═══ KRIZOVÝ EMAIL — notifikace pro nové/aktivní krize ═══
      for (const crisis of (activeCrises || [])) {
        const partName = crisis.part_name;
        const daysActive = crisis.days_active || 0;

        // Skip if crisis email was already sent for this part in last 24h
        try {
          const { data: recentCrisisEmail } = await sb
            .from("did_pending_emails")
            .select("id")
            .eq("email_type", "crisis")
            .ilike("subject", `%${partName}%`)
            .gte("created_at", new Date(Date.now() - 24 * 3600000).toISOString())
            .limit(1);

          if (recentCrisisEmail && recentCrisisEmail.length > 0) {
            console.log(`[CRISIS EMAIL] Skipped — already sent for ${partName} in last 24h`);
            continue;
          }

          // Only send email for NEW crises (days_active <= 1) or critical escalations (7+ days)
          const isNewCrisis = daysActive <= 1;
          const isCriticalEscalation = daysActive >= 7;
          if (!isNewCrisis && !isCriticalEscalation) continue;

          const emailLabel = isNewCrisis ? "NOVÁ KRIZE" : "KRITICKÁ ESKALACE";
          const crisisSubject = isNewCrisis
            ? `\u{1F6A8} Karel: KRIZE \u2014 ${partName}`
            : `\u{1F6A8} Karel: KRIZE ${daysActive}. den \u2014 ${partName}`;

          const crisisBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#dc2626;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;text-align:center">
    <h1 style="margin:0;font-size:20px">\u{1F6A8} ${emailLabel}</h1>
  </div>
  <div style="border:1px solid #fca5a5;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    <p style="margin:0 0 8px"><strong>\u010c\u00e1st:</strong> ${partName}</p>
    <p style="margin:0 0 8px"><strong>F\u00e1ze:</strong> ${crisis.phase || "acute"}</p>
    <p style="margin:0 0 8px"><strong>Trigger:</strong> ${crisis.trigger_description || "Nespecifikov\u00e1no"}</p>
    <p style="margin:0 0 8px"><strong>Z\u00e1va\u017enost:</strong> ${crisis.severity || "nespecifikov\u00e1na"}</p>
    ${daysActive > 1 ? `<p style="margin:0 0 8px"><strong>Dn\u00ed aktivn\u00ed:</strong> ${daysActive}</p>` : ""}
    <div style="margin:16px 0;padding:12px;background:#fef2f2;border-radius:6px;border-left:4px solid #dc2626">
      <strong>\u26A0\uFE0F Doporu\u010den\u00ed Karla:</strong><br/>
      P\u0159i krizi prioritizuj STABILIZACI. Neotev\u00edrej traumatick\u00fd materi\u00e1l.
      Pou\u017eij grounding techniky. Detailn\u00ed pl\u00e1n je na dashboardu.
    </div>
    <div style="text-align:center;margin-top:16px">
      <a href="https://karel-pomoc.lovable.app/hub" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
        Otev\u0159\u00edt dashboard \u2192
      </a>
    </div>
  </div>
</div>`;

          const crisisTextPlain = `\u{1F6A8} ${emailLabel} \u2014 ${partName}\nF\u00e1ze: ${crisis.phase || "acute"}\nTrigger: ${crisis.trigger_description || "Nespecifikov\u00e1no"}\nDoporu\u010den\u00ed: Stabilizace, grounding, neotev\u00edrat trauma.`;

          const kataEmail = Deno.env.get("KATA_EMAIL");
          const mamkaEmail = Deno.env.get("MAMKA_EMAIL") || Deno.env.get("HANKA_EMAIL");

          for (const recipient of [
            { email: kataEmail, name: "K\u00e1\u0165a" },
            { email: mamkaEmail, name: "Hanka" },
          ]) {
            if (recipient.email && recipient.email.includes("@")) {
              await sendOrQueueEmail(sb, {
                toEmail: recipient.email,
                toName: recipient.name,
                subject: crisisSubject,
                bodyHtml: crisisBody,
                bodyText: crisisTextPlain,
                emailType: "crisis",
              });
            }
          }
          console.log(`[CRISIS EMAIL] Sent for ${partName} (${emailLabel})`);
        } catch (crisisEmailErr) {
          console.warn(`[CRISIS EMAIL] Error for ${partName}:`, crisisEmailErr);
        }
      }
      console.log("[INFO] No webhook configured \u2014 crisis notification via email only");
    } catch (crisisErr) {
      console.warn("[daily-cycle] Crisis eval phase error (non-fatal):", crisisErr);
    }

    await setPhase("phase_6_card_autoupdate", "Fáze 6: Autonomní aktualizace karet");
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

    // ═══ AUTO-NÁVRH CÍLŮ — STATE-AWARE (F17-C5) ═══
    try {
      const todayStart = new Date().toISOString().slice(0, 10);
      const { count: todayProposed } = await sb.from("part_goals").select("id", { count: "exact", head: true }).eq("proposed_by", "karel").gte("created_at", todayStart);

      if ((todayProposed || 0) < 3) {
        const { data: allActiveParts } = await sb.from("did_part_registry").select("part_name").eq("status", "active");
        const { data: allActiveGoals } = await sb.from("part_goals").select("id, part_name, goal_type, goal_text, status, category").in("status", ["active", "proposed"]);
        const LOVABLE_API_KEY_PROP = Deno.env.get("LOVABLE_API_KEY");

        // ── Klasifikace stavu každé části ──
        const goalTypeMap: Record<string, string[]> = {
          crisis: ["safety"],
          unstable: ["stabilization", "safety"],
          stabilizing: ["consolidation", "stabilization"],
          stable: ["development", "consolidation"],
          progressing: ["integration", "development"],
          integrating: ["integration"],
        };

        const goalTypeForState: Record<string, string> = {
          crisis: "safety", unstable: "stabilization", stabilizing: "consolidation",
          stable: "development", progressing: "integration", integrating: "integration",
        };

        // Load crisis events once
        const { data: openCrises } = await sb.from("crisis_events").select("part_name, phase").not("phase", "eq", "closed");
        const crisisSet = new Set((openCrises || []).map((c: any) => c.part_name));

        const partsToPropose: Array<{ partName: string; stateCategory: string; reason: string }> = [];

        for (const part of (allActiveParts || [])) {
          const pn = part.part_name;

          // 0. Check manual override
          const { data: regData } = await sb
            .from("did_part_registry")
            .select("manual_state_override")
            .eq("part_name", pn)
            .maybeSingle();

          let stateCategory = "stable";
          let skipAutoClassification = false;

          if (regData?.manual_state_override) {
            stateCategory = regData.manual_state_override;
            skipAutoClassification = true;
            console.log(`[PART STATE] ${pn}: MANUAL OVERRIDE → ${stateCategory}`);
          }

          if (!skipAutoClassification) {
            // 1. Crisis check
            const isInCrisis = crisisSet.has(pn);

            // 2. Load 7-day metrics for trend
            const { data: recentMetrics } = await sb.from("daily_metrics")
              .select("metric_date, emotional_valence")
              .eq("part_name", pn)
              .gte("metric_date", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
              .order("metric_date", { ascending: true });

            let trendDirection: "improving" | "stable" | "declining" = "stable";
            const vals = (recentMetrics || []).filter((m: any) => m.emotional_valence != null).map((m: any) => m.emotional_valence);
            if (vals.length >= 3) {
              const firstHalf = vals.slice(0, Math.floor(vals.length / 2));
              const secondHalf = vals.slice(Math.floor(vals.length / 2));
              const avgFirst = firstHalf.reduce((a: number, b: number) => a + b, 0) / firstHalf.length;
              const avgSecond = secondHalf.reduce((a: number, b: number) => a + b, 0) / secondHalf.length;
              if (avgSecond > avgFirst + 0.5) trendDirection = "improving";
              else if (avgSecond < avgFirst - 0.5) trendDirection = "declining";
            }

            // 3. Classify state
            if (isInCrisis) {
              stateCategory = "crisis";
            } else if (trendDirection === "declining") {
              stateCategory = "unstable";
            } else if (trendDirection === "improving") {
              const { data: lastCrisis } = await sb.from("crisis_events")
                .select("opened_at").eq("part_name", pn).eq("phase", "closed")
                .order("opened_at", { ascending: false }).limit(1);
              const daysSinceCrisis = lastCrisis?.[0]
                ? Math.floor((Date.now() - new Date(lastCrisis[0].opened_at).getTime()) / 86400000) : 999;
              stateCategory = daysSinceCrisis < 14 ? "stabilizing" : "progressing";
            }

            // ── INTEGRATING DETECTION (F17-D4) ──
            if (stateCategory === "stable" || stateCategory === "progressing") {
              let qualifiesForIntegrating = true;

              // Criterion 1: 21 days without crisis or instability
              const { data: recentCrises21d } = await sb
                .from("crisis_events")
                .select("id")
                .eq("part_name", pn)
                .gte("opened_at", new Date(Date.now() - 21 * 86400000).toISOString())
                .limit(1);

              if (recentCrises21d && recentCrises21d.length > 0) {
                qualifiesForIntegrating = false;
              }

              // Criterion 2: Evidence of cooperation in last 14 days
              if (qualifiesForIntegrating) {
                const cooperationKeywords = [
                  "spolupráce", "společně", "ko-prezence", "koprezence",
                  "sdílení", "integrace", "propojení", "komunikace mezi",
                  "vzájemně", "cooperation", "co-presence", "spolu",
                  "s jinou částí", "s částí",
                ];

                const { data: recentMemory } = await sb
                  .from("session_memory")
                  .select("key_points, positive_signals")
                  .eq("part_name", pn)
                  .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString());

                const { data: recentCoopNotes } = await sb
                  .from("therapist_notes")
                  .select("note_text")
                  .eq("part_name", pn)
                  .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString());

                const allText = [
                  ...(recentMemory || []).map((m: any) =>
                    [...(m.key_points || []), ...(m.positive_signals || [])].join(" ")
                  ),
                  ...(recentCoopNotes || []).map((n: any) => n.note_text || ""),
                ].join(" ").toLowerCase();

                const hasCooperation = cooperationKeywords.some(kw =>
                  allText.includes(kw.toLowerCase())
                );

                if (!hasCooperation) {
                  qualifiesForIntegrating = false;
                }
              }

              // Criterion 3: At least 1 completed development/integration goal
              if (qualifiesForIntegrating) {
                const { data: completedGoals } = await sb
                  .from("part_goals")
                  .select("id")
                  .eq("part_name", pn)
                  .eq("status", "completed")
                  .in("goal_type", ["development", "integration"])
                  .limit(1);

                if (!completedGoals || completedGoals.length === 0) {
                  qualifiesForIntegrating = false;
                }
              }

              // Criterion 4: No safety alerts in last 30 days
              if (qualifiesForIntegrating) {
                const { data: recentAlerts30d } = await sb
                  .from("safety_alerts")
                  .select("id")
                  .eq("part_name", pn)
                  .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString())
                  .not("status", "eq", "false_positive")
                  .limit(1);

                if (recentAlerts30d && recentAlerts30d.length > 0) {
                  qualifiesForIntegrating = false;
                }
              }

              if (qualifiesForIntegrating) {
                stateCategory = "integrating";
                console.log(
                  `[PART STATE] ${pn}: UPGRADED to integrating `
                  + `(21d stable, cooperation found, goal completed, no alerts)`
                );

                // First-time notification
                const { data: prevIntLog } = await sb
                  .from("system_health_log")
                  .select("id")
                  .eq("event_type", "part_integrating")
                  .ilike("message", `%${pn}%`)
                  .limit(1);

                if (!prevIntLog || prevIntLog.length === 0) {
                  try {
                    await sb.from("system_health_log").insert({
                      event_type: "part_integrating",
                      severity: "info",
                      message: `Část ${pn} dosáhla stavu INTEGRACE`,
                      details: { part_name: pn, criteria: "21d_stable, cooperation, goal_completed, no_alerts" },
                    });

                    const kataEmail = Deno.env.get("KATA_EMAIL");
                    const hankaEmail = Deno.env.get("HANKA_EMAIL") || Deno.env.get("MAMKA_PHONE");

                    const intSubject = `🟣 Karel: ${pn} je připravena na integraci!`;
                    const intBody = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
                      <div style="background:#7c3aed;color:white;padding:16px;border-radius:8px 8px 0 0;text-align:center">
                        <h2 style="margin:0">🟣 INTEGRACE — ${pn}</h2>
                      </div>
                      <div style="padding:16px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
                        <p><strong>Část ${pn}</strong> splnila všechna kritéria pro stav integrace:</p>
                        <ul>
                          <li>✅ 21+ dní stabilní (žádná krize)</li>
                          <li>✅ Evidence spolupráce s jinou částí</li>
                          <li>✅ Splněný rozvojový/integrační cíl</li>
                          <li>✅ Žádný bezpečnostní alert za 30 dní</li>
                        </ul>
                        <p>Doporučení: Zvažte integrační aktivity — ko-prezenci, sdílené vzpomínky, společné úkoly.</p>
                      </div>
                    </div>`;
                    const intText = `🟣 INTEGRACE — ${pn}\nSplněná kritéria: 21d stabilní, spolupráce, splněný cíl, bez alertů.\nDoporučení: Integrační aktivity.`;

                    for (const recipient of [
                      { email: kataEmail, name: "Káťa" },
                      { email: hankaEmail, name: "Hanka" },
                    ]) {
                      if (recipient.email && recipient.email.includes("@")) {
                        await sendOrQueueEmail(sb, {
                          toEmail: recipient.email,
                          toName: recipient.name,
                          subject: intSubject,
                          bodyHtml: intBody,
                          bodyText: intText,
                          emailType: "integrating",
                        });
                      }
                    }
                    console.log(`[INTEGRATING EMAIL] First-time notification sent for ${pn}`);
                  } catch (intNotifErr) {
                    console.warn(`[INTEGRATING EMAIL] Error:`, intNotifErr);
                  }
                }
              }
            }

            console.log(`[PART STATE] ${pn}: ${stateCategory}`);
          } // end skipAutoClassification

          // 4. Check existing goals compatibility
          const partGoals = (allActiveGoals || []).filter((g: any) => g.part_name === pn);
          const allowedTypes = goalTypeMap[stateCategory] || [];

          if (partGoals.length === 0) {
            // No active goals → propose new
            partsToPropose.push({ partName: pn, stateCategory, reason: "no_goals" });
          } else {
            // Check if existing goals are compatible
            let pausedCount = 0;
            for (const goal of partGoals) {
              const gt = goal.goal_type || goal.category || "";
              if (gt && !allowedTypes.includes(gt) && !allowedTypes.some((a: string) => gt.includes(a))) {
                // Pause incompatible goal
                await sb.from("part_goals").update({
                  status: "paused",
                  pause_reason: `state_change: ${stateCategory}`,
                  updated_at: new Date().toISOString(),
                } as any).eq("id", goal.id);
                pausedCount++;
                console.log(`[GOAL PAUSED] ${pn}: "${(goal.goal_text || "").slice(0, 40)}" (type ${gt} incompatible with ${stateCategory})`);
              }
            }
            if (pausedCount > 0 && pausedCount >= partGoals.length) {
              partsToPropose.push({ partName: pn, stateCategory, reason: "all_paused" });
            }
          }
        }

        // ── Propose goals for parts that need them ──
        if (LOVABLE_API_KEY_PROP && partsToPropose.length > 0) {
          const { callAiForJson: callAiGoal } = await import("../_shared/aiCallWrapper.ts");

          for (const pp of partsToPropose.slice(0, 3)) {
            try {
              const { data: recentMem } = await sb.from("session_memory")
                .select("key_points, unresolved, risk_signals, positive_signals")
                .eq("part_name", pp.partName).order("created_at", { ascending: false }).limit(5);

              const targetGoalType = goalTypeForState[pp.stateCategory] || "development";

              const stateRules = `
PRAVIDLA PRO NÁVRH CÍLŮ PODLE STAVU ČÁSTI:
Aktuální stav: ${pp.stateCategory.toUpperCase()}

CRISIS → Typ: SAFETY. Příklady: 'Bezpečně komunikovat 2x tento týden', 'Použít grounding techniku při flashbacku'. ZAKÁZÁNO: explorační, integrační.
UNSTABLE → Typ: STABILIZATION. Příklady: 'Dodržet denní rutinu 3 dny', 'Pojmenovat 1 emoci denně'. ZAKÁZÁNO: trauma processing.
STABILIZING → Typ: CONSOLIDATION. Příklady: 'Rozšířit bezpečné místo', 'Komunikovat s 1 další částí'.
STABLE → Typ: DEVELOPMENT. Příklady: 'Prozkoumat vztah k jiné části', 'Sdílet vzpomínku v bezpečném kontextu'.
PROGRESSING → Typ: INTEGRATION. Příklady: 'Spolupracovat s jinou částí na společném úkolu', 'Fungovat v ko-prezenci 10 min'.

Navrhni cíl typu "${targetGoalType}" pro stav "${pp.stateCategory}". Nikdy nenavrhuj integrační cíl pro část v krizi.`;

              const proposalResult = await callAiGoal({
                systemPrompt: `Jsi Karel — klinický psycholog. ${stateRules}`,
                userPrompt: `Část: "${pp.partName}" | Stav: ${pp.stateCategory} | Důvod návrhu: ${pp.reason}\n\nPOSLEDNÍ PAMĚŤ:\n${(recentMem || []).map((m: any) => `Klíčové: ${(m.key_points || []).join(", ")}\nNedořešené: ${(m.unresolved || []).join(", ")}`).join("\n---\n")}\n\nNavrhni JSON:\n{"goal_text": "stručný cíl (max 100 znaků)", "description": "popis a kritéria splnění", "goal_type": "${targetGoalType}", "category": "therapeutic|behavioral|emotional|relational|safety|integration|communication|daily_life", "priority": "${pp.stateCategory === "crisis" ? "high" : "normal"}", "milestones": [{"text": "první krok", "done": false}]}`,
                apiKey: LOVABLE_API_KEY_PROP,
                model: "google/gemini-2.5-flash",
                requiredKeys: ["goal_text", "category"],
                maxRetries: 0,
                fallback: null,
                callerName: "goal-proposal-stateful",
              });

              if (proposalResult.success && proposalResult.data) {
                const p = proposalResult.data as any;
                await sb.from("part_goals").insert({
                  part_name: pp.partName, goal_text: (p.goal_text || "").slice(0, 200),
                  description: (p.description || "").slice(0, 500), category: p.category || "therapeutic",
                  priority: p.priority || "normal", milestones: p.milestones || [],
                  status: "proposed", proposed_by: "karel",
                  goal_type: p.goal_type || targetGoalType,
                  state_at_creation: pp.stateCategory,
                } as any);
                console.log(`[daily-cycle] Karel proposed ${targetGoalType} goal for ${pp.partName} (state: ${pp.stateCategory}): "${(p.goal_text || "").slice(0, 50)}"`);
              }
            } catch (singleErr) {
              console.warn(`[daily-cycle] Goal proposal error for ${pp.partName}:`, singleErr);
            }
          }
        }
      }
    } catch (propErr) {
      console.warn("[daily-cycle] Goal proposal error:", propErr);
    }

    await setPhase("phase_7_operative_plan", "Fáze 7: Aktualizace operativního plánu");
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

    // ═══ FÁZE 7.5: ESKALAČNÍ EMAIL PRO ZPOŽDĚNÉ ÚKOLY ═══
    try {
      if (overdueTasks.length > 0) {
        const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
        const hankaEmail = MAMKA_EMAIL || null;
        const kataEmail = Deno.env.get("KATA_EMAIL") || null;

        // Group by assignee
        const byAssignee: Record<string, typeof overdueTasks> = {};
        for (const ot of overdueTasks) {
          const targets = ot.assignee === "both" ? ["hanka", "kata"] : [ot.assignee];
          for (const t of targets) {
            if (!byAssignee[t]) byAssignee[t] = [];
            byAssignee[t].push(ot);
          }
        }

        for (const [assignee, tasks] of Object.entries(byAssignee)) {
          const hasCritical = tasks.some(t => t.escalationLevel === "critical");
          const maxLevel = hasCritical ? "critical" : "warning";

          // Frequency control: critical=1x/day, warning=1x/3days
          const maxFrequencyMs = maxLevel === "critical" ? 86400000 : 3 * 86400000;
          const lastEmailAt = tasks[0]?.task?.last_escalation_email_at;
          if (lastEmailAt && (Date.now() - new Date(lastEmailAt).getTime()) < maxFrequencyMs) {
            console.log(`[TASK ESCALATION] Skipping email for ${assignee} — too recent (last: ${lastEmailAt})`);
            continue;
          }

          const criticalTasks = tasks.filter(t => t.escalationLevel === "critical");
          const warningTasks = tasks.filter(t => t.escalationLevel === "warning");

          const subject = hasCritical
            ? `Karel: 🚨 URGENT — ${criticalTasks.length} kriticky zpožděných úkolů!`
            : `Karel: ⏰ ${warningTasks.length} úkolů čeká na vyřízení`;

          let body = `<h2 style="color: ${hasCritical ? '#dc2626' : '#d97706'}">`;
          body += hasCritical ? `🚨 ${criticalTasks.length} kriticky zpožděných úkolů` : `⏰ ${warningTasks.length} úkolů čeká`;
          body += `</h2><p>Ahoj ${assignee === "hanka" ? "Hanko" : "Káťo"},</p>`;
          body += `<p>Tyto úkoly čekají na tvou pozornost:</p>`;

          if (criticalTasks.length > 0) {
            body += `<h3 style="color: #dc2626">🔴 KRITICKÉ (7+ dní)</h3><ul>`;
            for (const ct of criticalTasks) {
              body += `<li><strong>${ct.task.task}</strong> — ${ct.daysOverdue} dní`;
              if (ct.task.detail_instruction) body += `<br><small>Zadání: ${ct.task.detail_instruction}</small>`;
              body += `</li>`;
            }
            body += `</ul>`;
          }

          if (warningTasks.length > 0) {
            body += `<h3 style="color: #d97706">🟡 UPOZORNĚNÍ (3+ dní)</h3><ul>`;
            for (const wt of warningTasks) {
              body += `<li><strong>${wt.task.task}</strong> — ${wt.daysOverdue} dní</li>`;
            }
            body += `</ul>`;
          }

          body += `<p>Karel</p>`;

          {
            const targetEmail = assignee === "hanka" ? hankaEmail : kataEmail;
            if (targetEmail) {
              await sendOrQueueEmail(sb!, {
                toEmail: targetEmail,
                toName: assignee === "hanka" ? "Hanka" : "Káťa",
                subject,
                bodyHtml: body,
                emailType: "escalation",
              });
            } else {
              console.warn(`[TASK ESCALATION] No email for ${assignee}`);
            }
          }

          // Update last_escalation_email_at for these tasks
          const taskIds = tasks.map(t => t.task.id).filter(Boolean);
          if (taskIds.length > 0) {
            for (const tid of taskIds) {
              await sb.from("did_therapist_tasks").update({
                last_escalation_email_at: new Date().toISOString(),
              } as any).eq("id", tid);
            }
          }
        }
      }
    } catch (escErr) {
      console.warn("[daily-cycle] Task escalation email error:", escErr);
    }

    // ═══ FÁZE 7.6b: AUTO-FEEDBACK PRO SPLNĚNÉ/REVIEW ÚKOLY ═══
    try {
      const { data: feedbackCandidates } = await sb
        .from("did_therapist_tasks")
        .select("id, task, detail_instruction, assigned_to, status, created_at, completed_at, note")
        .in("status", ["done", "needs_review"])
        .order("completed_at", { ascending: false })
        .limit(10);

      const candidateIds = (feedbackCandidates || []).map((c: any) => c.id);
      const { data: existingAutoFb } = candidateIds.length > 0
        ? await sb.from("did_task_auto_feedback").select("task_id").in("task_id", candidateIds)
        : { data: [] };

      const alreadyHasFeedback = new Set((existingAutoFb || []).map((f: any) => f.task_id));
      const needsFeedback = (feedbackCandidates || []).filter((c: any) => !alreadyHasFeedback.has(c.id));

      if (needsFeedback.length > 0) {
        const LOVABLE_KEY_FB = Deno.env.get("LOVABLE_API_KEY");
        if (LOVABLE_KEY_FB) {
          const { callAiForJson: callAiFeedback } = await import("../_shared/aiCallWrapper.ts");

          for (const task of needsFeedback.slice(0, 5)) {
            try {
              // Gather context from session_memory
              const { data: recentMem } = await sb
                .from("session_memory")
                .select("key_points, positive_signals, risk_signals")
                .order("created_at", { ascending: false })
                .limit(3);

              const contextStr = (recentMem || []).map((m: any) =>
                [(m.key_points || []).join(", "), (m.positive_signals || []).join(", ")].filter(Boolean).join(" | ")
              ).join("\n").slice(0, 600);

              const fbResult = await callAiFeedback({
                systemPrompt: `Jsi Karel \u2014 klinick\u00fd psycholog. Generujes stru\u010dnou, konkr\u00e9tn\u00ed zp\u011btnou vazbu k spln\u011bn\u00fdm terapeutick\u00fdm \u00fakol\u016fm.

PRAVIDLA:
- Bu\u010f konkr\u00e9tn\u00ed, ne obecn\u00fd ("Dobr\u00e1 pr\u00e1ce" je ZAK\u00c1Z\u00c1NO)
- Zhodno\u0165 zda \u00fakol p\u0159isp\u011bl k terapeutick\u00e9mu c\u00edli
- Pokud \u00fakol byl spln\u011bn jen \u010d\u00e1ste\u010dn\u011b (status needs_review), \u0159ekni co je\u0161t\u011b chyb\u00ed
- Navrhni 1-2 konkr\u00e9tn\u00ed follow-up kroky
- quality_score: 1=nespln\u011bno, 2=\u010d\u00e1ste\u010dn\u011b, 3=spln\u011bno, 4=dob\u0159e spln\u011bno, 5=v\u00fdborn\u011b`,

                userPrompt: `\u00daKOL: "${task.task}"
DETAIL: ${task.detail_instruction || "\u017e\u00e1dn\u00fd"}
P\u0158I\u0158AZENO: ${task.assigned_to}
STATUS: ${task.status}
POZN\u00c1MKA TERAPEUTKY: ${task.note || "\u017e\u00e1dn\u00e1"}
VYTVO\u0158ENO: ${task.created_at}

KONTEXT:
${contextStr || "\u017d\u00e1dn\u00fd kontext k dispozici."}

Vra\u0165 JSON:
{
  "feedback_text": "2-4 v\u011bty konkr\u00e9tn\u00ed zp\u011btn\u00e9 vazby",
  "quality_score": 1-5,
  "suggestions": ["follow-up krok 1", "follow-up krok 2"]
}`,
                apiKey: LOVABLE_KEY_FB,
                model: "google/gemini-2.5-flash-lite",
                requiredKeys: ["feedback_text", "quality_score"],
                maxRetries: 0,
                fallback: null,
                callerName: "task-auto-feedback",
              });

              if (fbResult.success && fbResult.data) {
                const fb = fbResult.data as any;
                await sb.from("did_task_auto_feedback").insert({
                  task_id: task.id,
                  part_name: null,
                  feedback_text: String(fb.feedback_text || "").slice(0, 1000),
                  feedback_type: task.status === "needs_review" ? "partial_review" : "completion",
                  quality_score: Math.min(5, Math.max(1, Number(fb.quality_score) || 3)),
                  suggestions: (Array.isArray(fb.suggestions) ? fb.suggestions : []).slice(0, 3),
                  generated_by: "karel_daily_cycle",
                });
                console.log(`[TASK FEEDBACK] "${(task.task || "").slice(0, 30)}" \u2192 score ${fb.quality_score}`);
              }
            } catch (singleFbErr) {
              console.warn(`[TASK FEEDBACK] Error for task ${task.id}:`, singleFbErr);
            }
          }
        } else {
          console.log("[TASK FEEDBACK] No LOVABLE_API_KEY, skipping");
        }
      } else {
        console.log("[TASK FEEDBACK] No tasks need feedback");
      }
    } catch (fbErr) {
      console.warn("[TASK FEEDBACK] Error:", fbErr);
    }

    // ═══ FÁZE 7.6a: EMAIL RETRY — zpracuj pending emaily z did_pending_emails ═══
    try {
      const { data: pendingEmails } = await sb.from("did_pending_emails")
        .select("*")
        .eq("status", "pending")
        .lte("next_retry_at", new Date().toISOString())
        .lt("retry_count", 3)
        .order("created_at", { ascending: true })
        .limit(5);

      if (pendingEmails && pendingEmails.length > 0) {
        console.log(`[EMAIL RETRY] Processing ${pendingEmails.length} pending emails`);
        for (const pe of pendingEmails) {
          const result = await sendOrQueueEmail(sb, {
            toEmail: pe.to_email,
            toName: pe.to_name || "",
            subject: pe.subject,
            bodyHtml: pe.body_html,
            bodyText: pe.body_text || "",
            emailType: pe.email_type,
            isRetry: true,
          });

          if (result.sent) {
            await sb.from("did_pending_emails").update({
              status: "sent",
              sent_at: new Date().toISOString(),
            }).eq("id", pe.id);
          } else {
            const newRetryCount = (pe.retry_count || 0) + 1;
            await sb.from("did_pending_emails").update({
              retry_count: newRetryCount,
              error_message: result.error || "retry failed",
              next_retry_at: new Date(Date.now() + newRetryCount * 60 * 60000).toISOString(),
              status: newRetryCount >= 3 ? "failed" : "pending",
            }).eq("id", pe.id);
          }
        }
      }
    } catch (retryErr) {
      console.warn("[EMAIL RETRY] Error:", retryErr);
    }

    await setPhase("phase_8_therapist_intel", "Fáze 8: Therapist intelligence");
    // ═══ PHASE_3_THERAPIST_INTELLIGENCE — delegated to standalone function ═══
    // Replaced inline profiling (was ~150 lines of raw AI + ungoverned writes)
    // with delegation to karel-daily-therapist-intelligence which uses
    // encodeGovernedWrite + normalizeSignal + proper dedup markers
    try {
      const tpUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-daily-therapist-intelligence`;
      const tpController = new AbortController();
      const tpTimeout = setTimeout(() => tpController.abort(), 30000);
      const tpRes = await fetch(tpUrl, {
        method: "POST",
        signal: tpController.signal,
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "daily-cycle" }),
      });
      clearTimeout(tpTimeout);

      if (tpRes.ok) {
        const tpBody = await tpRes.json();
        criticalPhaseStatus.therapistIntelligenceOk = tpBody.ok !== false;
        console.log(`[PHASE_3] Therapist intelligence: HTTP ${tpRes.status}, ok=${tpBody.ok}, results=${JSON.stringify(tpBody.results || {})}`);
      } else {
        const errText = await tpRes.text().catch(() => "");
        console.error(`[PHASE_3] Therapist intelligence FAILED: HTTP ${tpRes.status} — ${errText.slice(0, 200)}`);
        // criticalPhaseStatus.therapistIntelligenceOk remains false
      }
    } catch (tpErr) {
      console.error("[PHASE_3] Therapist intelligence FAILED (timeout or network):", tpErr);
      // criticalPhaseStatus.therapistIntelligenceOk remains false
    }

    // ═══ FÁZE 6.5: PAMET_KAREL — krizová profilace terapeutek ═══
    try {
      const { data: activeCrisisAlerts } = await sb
        .from("crisis_alerts")
        .select("id, part_name")
        .not("status", "eq", "RESOLVED");

      if (activeCrisisAlerts && activeCrisisAlerts.length > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);

        for (const ac of activeCrisisAlerts) {
          // Load today's crisis_journal entry
          const { data: todayJournal } = await sb
            .from("crisis_journal")
            .select("hanka_cooperation, kata_cooperation, karel_notes")
            .eq("crisis_alert_id", ac.id)
            .eq("date", todayStr)
            .maybeSingle();

          if (!todayJournal) continue;

          // Load meeting messages from last 24h for this part
          const { data: recentMeeting } = await sb
            .from("did_meetings")
            .select("messages")
            .ilike("topic", `%${ac.part_name}%`)
            .gte("created_at", new Date(Date.now() - 24 * 3600000).toISOString())
            .order("created_at", { ascending: false })
            .limit(1);

          const meetingMsgs = recentMeeting?.[0]?.messages;
          const msgs = Array.isArray(meetingMsgs) ? meetingMsgs : [];
          const hankaCount = msgs.filter((m: any) =>
            (m.author || m.role || "").toLowerCase().includes("hanka") ||
            (m.author || m.role || "").toLowerCase().includes("hanička")
          ).length;
          const kataCount = msgs.filter((m: any) =>
            (m.author || m.role || "").toLowerCase().includes("kát") ||
            (m.author || m.role || "").toLowerCase().includes("kata")
          ).length;

          const karelNote = (todayJournal.karel_notes || "").split(".")[0] || "";

          // Write HANKA profile append
          const hankaContent = `\n\n=== AKTUALIZACE ${todayStr} ===\nKRIZOVÁ PORADA ${ac.part_name} — HANKA:\n- Počet příspěvků dnes: ${hankaCount}\n- Spolupráce: ${todayJournal.hanka_cooperation || "N/A"}\n- Poznámka Karla: ${karelNote}`;

          await sb.from("did_pending_drive_writes").insert({
            target_document: "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI",
            content: hankaContent,
            write_type: "append",
            status: "pending",
            priority: "low",
          });

          // Write KATA profile append
          const kataContent = `\n\n=== AKTUALIZACE ${todayStr} ===\nKRIZOVÁ PORADA ${ac.part_name} — KATA:\n- Počet příspěvků dnes: ${kataCount}\n- Spolupráce: ${todayJournal.kata_cooperation || "N/A"}\n- Poznámka Karla: ${karelNote}`;

          await sb.from("did_pending_drive_writes").insert({
            target_document: "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI",
            content: kataContent,
            write_type: "append",
            status: "pending",
            priority: "low",
          });

          console.log(`[PAMET_KAREL CRISIS] Appended crisis cooperation data for ${ac.part_name}`);
        }
      }
    } catch (pametErr) {
      console.warn("[PAMET_KAREL CRISIS] Error:", pametErr);
    }

    // ═══ PART STATUS AUTO-DETECTION ═══
    // Detect parts that started communicating but are marked as sleeping
    try {
      const recentActivityCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { data: newlyActiveThreads } = await sb
        .from("did_threads")
        .select("part_name, last_activity_at")
        .gte("last_activity_at", recentActivityCutoff);

      const checkedParts = new Set<string>();
      for (const part of newlyActiveThreads || []) {
        const normalizedName = part.part_name?.trim();
        if (!normalizedName || checkedParts.has(normalizedName.toLowerCase())) continue;
        checkedParts.add(normalizedName.toLowerCase());

        const { data: inRegistry } = await sb
          .from("did_part_registry")
          .select("id, status")
          .ilike("part_name", normalizedName)
          .single();

        if (inRegistry && inRegistry.status === "sleeping") {
          console.log(`[PART-STATUS] Detected sleeping part with recent activity: ${normalizedName}`);
          try {
            const syncUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-part-status-sync`;
            const syncRes = await fetch(syncUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
              },
              body: JSON.stringify({
                part_id: inRegistry.id,
                part_name: normalizedName,
                new_status: "active",
                reason: `Část začala komunikovat po období neaktivity (${part.last_activity_at})`,
                triggered_by: "karel_autonomous",
              }),
            });
            console.log(`[PART-STATUS] Sync result for ${normalizedName}: ${syncRes.status}`);
          } catch (syncErr) {
            console.warn(`[PART-STATUS] Failed to sync ${normalizedName}:`, syncErr);
          }
        }
      }
    } catch (partStatusErr) {
      console.warn("[PART-STATUS] Auto-detection failed (non-fatal):", partStatusErr);
    }

    await setPhase("phase_9_queue_flush", "Fáze 9: Drive queue flush");
    // ═══ PHASE_9_QUEUE_FLUSH_AND_POST_ACTIONS ═══
    // Moved here so ALL write-producing phases (therapist intelligence, PAMET_KAREL, crisis escalation)
    // have already inserted their did_pending_drive_writes before we flush.
    try {
      const { count: pendingWriteCount } = await sb.from("did_pending_drive_writes")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");

      if ((pendingWriteCount || 0) > 0) {
        console.log(`[PHASE_9] ${pendingWriteCount} pending Drive writes, triggering queue processor`);
        const qpUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-drive-queue-processor`;
        const qpRes = await fetch(qpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ triggered_by: "daily-cycle" }),
        });
        if (qpRes.ok) {
          criticalPhaseStatus.queueFlushTriggeredOk = true;
          console.log(`[PHASE_9] Queue processor triggered: ${qpRes.status}`);
        } else {
          console.error(`[PHASE_9] Queue processor FAILED: HTTP ${qpRes.status}`);
        }
      } else {
        criticalPhaseStatus.queueFlushTriggeredOk = true;
        console.log("[PHASE_9] No pending Drive writes, skipping flush");
      }
    } catch (flushErr) {
      console.error("[PHASE_9] Queue flush FAILED:", flushErr);
    }

    await setPhase("phase_10_cleanup", "Fáze 10: Závěrečný cleanup");
    // ═══ PHASE_10_CLEANUP_AND_LOGGING ═══

    try {
      const alertCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      await sb.from("safety_alerts").delete().in("status", ["resolved", "false_positive"]).lt("created_at", alertCutoff);
      console.log("[PHASE_10] Old safety alerts cleanup done");
    } catch (e) {
      console.warn("[PHASE_10] Safety alerts cleanup failed:", e);
    }

    // ── DISABLED: karel-daily-refresh — context-prime (Job 30) runs independently as its own cron ──
    // try {
    //   const refreshUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-daily-refresh`;
    //   const refreshRes = await fetch(refreshUrl, { ... });
    // } catch (e) { ... }

    // ── REMOVED: karel-follow-through — deprecated dead code (replaced by Guardian + Reactive loop) ──

    // ── DISABLED: karel-crisis-research — guardian loop covers crisis escalations independently ──
    // try {
    //   await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-crisis-research`, { ... });
    // } catch (e) { ... }

    // ═══ is_processed — MOVED HERE from earlier position ═══
    // Only mark threads/conversations as processed when ALL critical phases succeeded.
    // If any critical phase failed, threads remain unprocessed → will be retried next cycle.
    const allCriticalOk = criticalPhaseStatus.therapistIntelligenceOk
      && criticalPhaseStatus.queueFlushTriggeredOk
      && criticalPhaseStatus.cardPipelineOk;
    // NOTE: dashboardOk and operativePlanOk are logged but do NOT block is_processed.
    // They are presentation/coordination outputs, not primary ingest success indicators.

    console.log(`[PHASE_10] criticalPhaseStatus: ${JSON.stringify(criticalPhaseStatus)}, allCriticalOk=${allCriticalOk}`);

    const threadIds = threads.map(t => t.id);
    const convIds = conversations.map(c => c.id);
    if (allCriticalOk) {
      if (threadIds.length > 0) {
        await sb.from("did_threads").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", threadIds);
      }
      if (convIds.length > 0) {
        await sb.from("did_conversations").update({ is_processed: true, processed_at: new Date().toISOString() }).in("id", convIds);
      }
      console.log(`[PHASE_10] ✅ Marked ${threadIds.length} threads + ${convIds.length} conversations as processed`);
    } else {
      console.warn(`[PHASE_10] ⚠️ NOT marking ${threadIds.length} threads + ${convIds.length} conversations as processed — critical phases incomplete`);
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
    console.error('[DAILY-CYCLE FATAL ERROR]', error?.message || error, error?.stack || '');

    if (sb && cycleId) {
      try {
        await sb.from("did_update_cycles").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          report_summary: `FATAL: ${(error?.message || String(error))}`.slice(0, 500),
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
