// FIX 9.K.1c-PRE Krok 4 BULK v2 — Recursive + system identity filter + source folder
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PER_FETCH_TIMEOUT_MS = 15_000;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const SECTION_RE = /^##\s*([A-M])\./;
const APPEND_RE = /^---\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*---\s*$/;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function getAccessToken(): Promise<string> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findRootKartoteka(token: string): Promise<string | null> {
  const variants = ["kartoteka_DID", "Kartoteka_DID", "Kartot\u00e9ka_DID", "KARTOTEKA_DID"];
  for (const v of variants) {
    const q = `name='${v}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const params = new URLSearchParams({
      q, fields: "files(id,name)", pageSize: "5",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.files?.[0]) return data.files[0].id;
  }
  return null;
}

async function listChildren(token: string, folderId: string) {
  const all: any[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    all.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

type DocMeta = { id: string; name: string; modifiedTime?: string; folder_name: string; folder_id: string };

async function walkDocs(token: string, folderId: string, folderName: string, depth: number, maxDepth: number, out: DocMeta[]) {
  const children = await listChildren(token, folderId);
  for (const c of children) {
    if (c.mimeType === DOC_MIME) {
      out.push({ id: c.id, name: c.name, modifiedTime: c.modifiedTime, folder_name: folderName, folder_id: folderId });
    } else if (c.mimeType === FOLDER_MIME && depth < maxDepth) {
      await walkDocs(token, c.id, c.name, depth + 1, maxDepth, out);
    }
  }
}

async function exportDoc(token: string, fileId: string): Promise<string> {
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`export ${fileId}: ${res.status}`);
  return await res.text();
}

function stripDiacritics(v: string) { return v.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function norm(s: string) { return stripDiacritics(s || "").toLowerCase().trim(); }

function analyzeContent(content: string) {
  const lines = content.split("\n");
  const sections = new Set<string>();
  let lastAppend: string | null = null;
  for (const line of lines) {
    const m = line.match(SECTION_RE); if (m) sections.add(m[1]);
    const a = line.match(APPEND_RE); if (a) lastAppend = a[1];
  }
  return {
    char_count: content.length, line_count: lines.length,
    section_count: sections.size, sections_found: Array.from(sections).sort(),
    last_append_log_date: lastAppend,
  };
}

function classifyFormat(sc: number): "structured" | "legacy_freeform" { return sc >= 3 ? "structured" : "legacy_freeform"; }

function matchDocsForPart(
  docs: DocMeta[],
  part: { part_name: string; drive_folder_label?: string | null; aliases?: string[] | null },
): { docs: DocMeta[]; matched_by: string } {
  const candidates = new Map<string, { d: DocMeta; rank: number }>();
  const partN = norm(part.part_name);
  const labelN = part.drive_folder_label ? norm(part.drive_folder_label) : null;
  const aliasesN = (part.aliases || []).map(norm).filter(Boolean);

  for (const d of docs) {
    const nName = norm(d.name);
    let rank = 0;
    if (labelN && nName === labelN) rank = 1;
    else if (nName === partN) rank = 2;
    else if (partN.length >= 3 && nName.includes(partN)) rank = 3;
    else {
      for (const a of aliasesN) {
        if (a.length >= 3 && nName.includes(a)) { rank = 4; break; }
      }
    }
    if (rank > 0) {
      const prev = candidates.get(d.id);
      if (!prev || rank < prev.rank) candidates.set(d.id, { d, rank });
    }
  }
  const arr = Array.from(candidates.values());
  if (arr.length === 0) return { docs: [], matched_by: "none" };
  const minRank = Math.min(...arr.map(x => x.rank));
  const labels = ["", "drive_folder_label_exact", "part_name_exact", "part_name_substring", "alias_substring"];
  // Order: lower rank first, then newest modifiedTime, then cap at 5 to bound export cost
  arr.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const am = a.d.modifiedTime || ""; const bm = b.d.modifiedTime || "";
    return bm > am ? 1 : -1;
  });
  const capped = arr.slice(0, 5).map(x => x.d);
  return { docs: capped, matched_by: labels[minRank] };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun: boolean = body.dry_run !== false;
    const partNamesFilter: string[] | null = Array.isArray(body.part_names) ? body.part_names : null;
    const maxDepth: number = typeof body.max_depth === "number" ? body.max_depth : 3;
    let rootFolderId: string | null = body.root_folder_id ?? body.folder_id ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Načti aktivní části + system identity filter
    let q = supabase
      .from("did_part_registry")
      .select("id, user_id, part_name, drive_folder_label, aliases, status, drive_doc_id, card_format")
      .neq("status", "archived")
      .not("part_name", "ilike", "QUARANTINED_%");
    if (partNamesFilter && partNamesFilter.length > 0) {
      q = q.in("part_name", partNamesFilter);
    }
    const { data: rawParts, error: partsErr } = await q;
    if (partsErr) throw new Error(`registry select: ${partsErr.message}`);
    const SYSTEM_LOWER = new Set(["karel", "káťa", "kata"]);
    const parts = (rawParts || []).filter(p => !SYSTEM_LOWER.has((p.part_name || "").toLowerCase()));

    if (parts.length === 0) {
      return new Response(JSON.stringify({ ok: true, summary: { total_parts: 0 }, results: [] }, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2) Drive recursive listing
    const token = await getAccessToken();
    if (!rootFolderId) rootFolderId = await findRootKartoteka(token);
    if (!rootFolderId) {
      return new Response(JSON.stringify({ ok: false, error: "KARTOTEKA_DID root not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const docs: DocMeta[] = [];
    await walkDocs(token, rootFolderId, "ROOT", 0, maxDepth, docs);

    const results: any[] = [];
    const missingCards: string[] = [];
    const freeformCards: string[] = [];
    let matchedSingle = 0, matchedWithDup = 0, errors = 0;

    for (const part of parts) {
      try {
        const { docs: matches, matched_by } = matchDocsForPart(docs, part);
        if (matches.length === 0) {
          missingCards.push(part.part_name);
          results.push({ part_name: part.part_name, status: "missing_card", canonical_file_id: null, matched_by });
          if (!dryRun) {
            await supabase.from("did_part_registry")
              .update({ card_format: "missing", drive_doc_id: null }).eq("id", part.id);
          }
          continue;
        }

        const analyzed: any[] = [];
        for (const m of matches) {
          try {
            const content = await exportDoc(token, m.id);
            const stats = analyzeContent(content);
            analyzed.push({ file_id: m.id, name: m.name, source_folder_name: m.folder_name, source_folder_id: m.folder_id, last_modified: m.modifiedTime, ...stats });
          } catch (e) {
            analyzed.push({ file_id: m.id, name: m.name, source_folder_name: m.folder_name, source_folder_id: m.folder_id, last_modified: m.modifiedTime, error: (e as Error).message, char_count: 0, section_count: 0, last_append_log_date: null });
          }
        }

        analyzed.sort((a, b) => {
          if (b.char_count !== a.char_count) return b.char_count - a.char_count;
          const ad = a.last_append_log_date || ""; const bd = b.last_append_log_date || "";
          if (bd !== ad) return bd > ad ? 1 : -1;
          const am = a.last_modified || ""; const bm = b.last_modified || "";
          return bm > am ? 1 : -1;
        });
        const canonical = analyzed[0];
        const alternates = analyzed.slice(1);
        const cardFormat = classifyFormat(canonical.section_count || 0);
        if (cardFormat === "legacy_freeform") freeformCards.push(part.part_name);
        if (matches.length === 1) matchedSingle++; else matchedWithDup++;

        results.push({
          part_name: part.part_name,
          status: matches.length === 1 ? "matched_single" : "matched_with_duplicate",
          matched_by,
          canonical_file_id: canonical.file_id,
          canonical_name: canonical.name,
          source_folder_name: canonical.source_folder_name,
          source_folder_id: canonical.source_folder_id,
          alternates: alternates.map(a => ({ file_id: a.file_id, name: a.name, source_folder_name: a.source_folder_name, char_count: a.char_count })),
          section_count: canonical.section_count,
          char_count: canonical.char_count,
          last_append_log_date: canonical.last_append_log_date,
          card_format: cardFormat,
        });

        if (!dryRun) {
          const { error: upErr } = await supabase.from("did_part_registry")
            .update({ drive_doc_id: canonical.file_id, card_format: cardFormat })
            .eq("id", part.id);
          if (upErr) throw new Error(`update registry: ${upErr.message}`);
          if (alternates.length > 0) {
            await supabase.from("decision_traces").insert({
              triggered_by: "karel-did-drive-bulk-set-canonical",
              outcome: "drive_duplicate_resolved",
              snapshot_ref: {
                part_name: part.part_name, part_id: part.id, user_id: part.user_id,
                canonical_file_id: canonical.file_id,
                canonical_source_folder: canonical.source_folder_name,
                legacy_file_ids: alternates.map(a => a.file_id),
                section_count: canonical.section_count, char_count: canonical.char_count,
                card_format: cardFormat, matched_by, decided_at: new Date().toISOString(),
              },
              reasoning: `Bulk canonicalization (recursive): vybrán Doc ${canonical.file_id} (${canonical.char_count} chars, ${canonical.section_count} sekcí) ze složky ${canonical.source_folder_name}, nahrazuje ${alternates.length} alternativ(y). Match: ${matched_by}.`,
            });
          }
        }
      } catch (e) {
        errors++;
        results.push({ part_name: part.part_name, status: "error", error: (e as Error).message });
      }
    }

    const summary = {
      total_parts: parts.length,
      total_docs_scanned: docs.length,
      matched_single: matchedSingle,
      matched_with_duplicate_resolved: matchedWithDup,
      missing_cards: missingCards.length,
      freeform_cards: freeformCards.length,
      errors,
      dry_run: dryRun,
      root_folder_id: rootFolderId,
      max_depth: maxDepth,
    };

    return new Response(JSON.stringify({
      ok: true, summary, results, missing_cards: missingCards, freeform_cards: freeformCards,
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
