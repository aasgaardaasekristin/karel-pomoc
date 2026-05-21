// FIX 9.K.1c-PRE Krok 4 BULK — Audit + set canonical drive_doc_id pro VŠECHNY části
// Input: { dry_run?: boolean, part_names?: string[]|null, folder_id?: string }
// Default folder_id: KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY (auto-resolve)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PER_FETCH_TIMEOUT_MS = 15_000;
const SECTION_RE = /^##\s*([A-M])\./;
const APPEND_RE = /^---\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*---\s*$/;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findFolders(token: string, name: string, parentId?: string) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({
    q, fields: "files(id,name)", pageSize: "20",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return (data.files || []) as Array<{ id: string; name: string }>;
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const folders = await findFolders(token, name, parentId);
  return folders[0]?.id || null;
}

async function resolveAktivniFragmentyFolder(token: string): Promise<string | null> {
  const variants = ["kartoteka_DID", "Kartoteka_DID", "Kartot\u00e9ka_DID", "KARTOTEKA_DID"];
  for (const v of variants) {
    const roots = await findFolders(token, v);
    for (const r of roots) {
      const sub = await findFolder(token, "01_AKTIVNI_FRAGMENTY", r.id);
      if (sub) return sub;
    }
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string) {
  const q = `'${folderId}' in parents and trashed=false`;
  const all: Array<{ id: string; name: string; mimeType?: string; modifiedTime?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q, fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "1000",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    all.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

async function exportDoc(token: string, fileId: string): Promise<string> {
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`export ${fileId}: ${res.status}`);
  return await res.text();
}

function stripDiacritics(v: string) {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function norm(s: string) { return stripDiacritics(s || "").toLowerCase().trim(); }

function analyzeContent(content: string) {
  const lines = content.split("\n");
  const sections = new Set<string>();
  let lastAppend: string | null = null;
  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) sections.add(m[1]);
    const a = line.match(APPEND_RE);
    if (a) lastAppend = a[1];
  }
  return {
    char_count: content.length,
    line_count: lines.length,
    section_count: sections.size,
    sections_found: Array.from(sections).sort(),
    last_append_log_date: lastAppend,
  };
}

function classifyFormat(section_count: number): "structured" | "legacy_freeform" {
  return section_count >= 3 ? "structured" : "legacy_freeform";
}

type DocMeta = { id: string; name: string; modifiedTime?: string };

function matchDocsForPart(
  docs: DocMeta[],
  part: { part_name: string; drive_folder_label?: string | null; aliases?: string[] | null },
): DocMeta[] {
  const candidates = new Map<string, DocMeta>();
  const partN = norm(part.part_name);
  const labelN = part.drive_folder_label ? norm(part.drive_folder_label) : null;
  const aliasesN = (part.aliases || []).map(norm).filter(Boolean);

  for (const d of docs) {
    const nName = norm(d.name);
    if (labelN && nName === labelN) { candidates.set(d.id, d); continue; }
    if (nName === partN) { candidates.set(d.id, d); continue; }
    if (nName.includes(partN) && partN.length >= 3) { candidates.set(d.id, d); continue; }
    for (const a of aliasesN) {
      if (a.length >= 3 && nName.includes(a)) { candidates.set(d.id, d); break; }
    }
  }
  return Array.from(candidates.values());
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun: boolean = body.dry_run !== false; // default true (bezpečnost)
    const partNamesFilter: string[] | null = Array.isArray(body.part_names) ? body.part_names : null;
    let folderId: string | null = body.folder_id ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Načti aktivní části
    let q = supabase
      .from("did_part_registry")
      .select("id, user_id, part_name, drive_folder_label, aliases, status, drive_doc_id, card_format")
      .neq("status", "archived");
    if (partNamesFilter && partNamesFilter.length > 0) {
      q = q.in("part_name", partNamesFilter);
    }
    const { data: parts, error: partsErr } = await q;
    if (partsErr) throw new Error(`registry select: ${partsErr.message}`);
    if (!parts || parts.length === 0) {
      return new Response(JSON.stringify({ ok: true, summary: { total_parts: 0 }, results: [] }, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2) Drive listing
    const token = await getAccessToken();
    if (!folderId) folderId = await resolveAktivniFragmentyFolder(token);
    if (!folderId) {
      return new Response(JSON.stringify({ ok: false, error: "01_AKTIVNI_FRAGMENTY folder not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const allFiles = await listFilesInFolder(token, folderId);
    const docs: DocMeta[] = allFiles
      .filter(f => f.mimeType === "application/vnd.google-apps.document")
      .map(f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));

    const results: any[] = [];
    const missingCards: string[] = [];
    const freeformCards: string[] = [];
    let matchedSingle = 0;
    let matchedWithDup = 0;
    let errors = 0;

    for (const part of parts) {
      try {
        const matches = matchDocsForPart(docs, part);
        if (matches.length === 0) {
          missingCards.push(part.part_name);
          results.push({
            part_name: part.part_name,
            status: "missing_card",
            canonical_file_id: null,
            note: "Žádný Doc ve složce nematchuje part_name ani aliases",
          });
          if (!dryRun) {
            await supabase.from("did_part_registry")
              .update({ card_format: "missing", drive_doc_id: null })
              .eq("id", part.id);
          }
          continue;
        }

        // analyze each match
        const analyzed: any[] = [];
        for (const m of matches) {
          try {
            const content = await exportDoc(token, m.id);
            const stats = analyzeContent(content);
            analyzed.push({ file_id: m.id, name: m.name, last_modified: m.modifiedTime, ...stats });
          } catch (e) {
            analyzed.push({ file_id: m.id, name: m.name, last_modified: m.modifiedTime, error: (e as Error).message, char_count: 0, section_count: 0, last_append_log_date: null });
          }
        }

        // pick canonical: max char_count, tiebreak by last_append_log_date desc, then modifiedTime desc
        analyzed.sort((a, b) => {
          if (b.char_count !== a.char_count) return b.char_count - a.char_count;
          const ad = a.last_append_log_date || ""; const bd = b.last_append_log_date || "";
          if (bd !== ad) return bd > ad ? 1 : -1;
          const am = a.last_modified || ""; const bm = b.last_modified || "";
          return bm > am ? 1 : -1;
        });
        const canonical = analyzed[0];
        const alternates = analyzed.slice(1).map(a => a.file_id);
        const cardFormat = classifyFormat(canonical.section_count || 0);
        if (cardFormat === "legacy_freeform") freeformCards.push(part.part_name);

        if (matches.length === 1) matchedSingle++; else matchedWithDup++;

        results.push({
          part_name: part.part_name,
          status: matches.length === 1 ? "matched_single" : "matched_with_duplicate",
          canonical_file_id: canonical.file_id,
          canonical_name: canonical.name,
          alternates,
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
                part_name: part.part_name,
                part_id: part.id,
                user_id: part.user_id,
                canonical_file_id: canonical.file_id,
                legacy_file_ids: alternates,
                section_count: canonical.section_count,
                char_count: canonical.char_count,
                card_format: cardFormat,
                decided_at: new Date().toISOString(),
              },
              reasoning: `Bulk canonicalization: vybrán Doc ${canonical.file_id} (${canonical.char_count} chars, ${canonical.section_count} sekcí), nahrazuje ${alternates.length} alternativ(y).`,
            });
          }
        }
      } catch (e) {
        errors++;
        results.push({
          part_name: part.part_name,
          status: "error",
          error: (e as Error).message,
        });
      }
    }

    const summary = {
      total_parts: parts.length,
      matched_single: matchedSingle,
      matched_with_duplicate_resolved: matchedWithDup,
      missing_cards: missingCards.length,
      freeform_cards: freeformCards.length,
      errors,
      dry_run: dryRun,
      folder_id: folderId,
    };

    return new Response(JSON.stringify({
      ok: true, summary, results, missing_cards: missingCards, freeform_cards: freeformCards,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
