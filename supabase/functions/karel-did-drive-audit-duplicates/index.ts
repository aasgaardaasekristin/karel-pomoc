// FIX 9.K.1c-PRE — Drive duplicate audit
// Najde duplicitní karty v 01_AKTIVNI_FRAGMENTY/ pro daný part_name (nebo defaultně TUNDRUPEK + ARTHUR),
// vrátí kandidáty s char_count, line_count, last_modified, last_append_log_date, section_count
// a doporučí kanonický fileId.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PER_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth credentials");
  }
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
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

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const variants = ["kartoteka_DID", "Kartoteka_DID", "Kartot\u00e9ka_DID", "KARTOTEKA_DID"];
  for (const v of variants) {
    const candidates = await findFolders(token, v);
    for (const c of candidates) {
      const sub = await findFolder(token, "01_AKTIVNI_FRAGMENTY", c.id);
      if (sub) return c.id;
    }
    if (candidates[0]?.id) return candidates[0].id;
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string) {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,modifiedTime)",
    pageSize: "200",
  });
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return (data.files || []) as Array<{ id: string; name: string; mimeType?: string; modifiedTime?: string }>;
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

function nameMatchesPart(fileName: string, partName: string): boolean {
  const f = stripDiacritics(fileName).toLowerCase();
  const p = stripDiacritics(partName).toLowerCase();
  return f.includes(p);
}

function analyzeContent(content: string) {
  const lines = content.split("\n");
  const sections = new Set<string>();
  const sectionRe = /^##\s*([A-M])\./;
  for (const line of lines) {
    const m = line.match(sectionRe);
    if (m) sections.add(m[1]);
  }
  // last append-log header: --- [YYYY-MM-DD HH:MM] ---
  const appendRe = /^---\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*---\s*$/;
  let lastAppend: string | null = null;
  for (const line of lines) {
    const m = line.match(appendRe);
    if (m) lastAppend = m[1];
  }
  return {
    char_count: content.length,
    line_count: lines.length,
    section_count: sections.size,
    sections_found: Array.from(sections).sort(),
    last_append_log_date: lastAppend,
  };
}

function pickCanonical(cands: Array<any>) {
  if (cands.length === 0) return;
  if (cands.length === 1) { cands[0].recommended_canonical = true; return; }
  // Strategy: highest char_count
  const byChars = [...cands].sort((a, b) => b.char_count - a.char_count);
  const topChars = byChars[0];
  // Most recent append-log
  const withAppend = cands.filter(c => c.last_append_log_date);
  withAppend.sort((a, b) => (b.last_append_log_date! > a.last_append_log_date! ? 1 : -1));
  const topAppend = withAppend[0] ?? null;

  let conflict = false;
  let winner = topChars;
  if (topAppend && topAppend.file_id !== topChars.file_id) {
    conflict = true;
    winner = null as any;
  }
  for (const c of cands) {
    c.recommended_canonical = winner ? c.file_id === winner.file_id : null;
    if (conflict) c.conflict = true;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const requested: string[] = body.part_name
      ? [String(body.part_name).toUpperCase()]
      : ["TUNDRUPEK", "ARTHUR"];

    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) {
      return new Response(JSON.stringify({ ok: false, error: "KARTOTEKA_DID not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", root);
    if (!aktivniId) {
      return new Response(JSON.stringify({ ok: false, error: "01_AKTIVNI_FRAGMENTY not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allFiles = await listFilesInFolder(token, aktivniId);
    const docs = allFiles.filter(f => f.mimeType === "application/vnd.google-apps.document");

    const duplicates: any[] = [];
    for (const partName of requested) {
      const matches = docs.filter(f => nameMatchesPart(f.name, partName));
      const candidates: any[] = [];
      for (const m of matches) {
        try {
          const content = await exportDoc(token, m.id);
          const stats = analyzeContent(content);
          candidates.push({
            file_id: m.id,
            name: m.name,
            last_modified: m.modifiedTime ?? null,
            ...stats,
          });
        } catch (e) {
          candidates.push({
            file_id: m.id,
            name: m.name,
            last_modified: m.modifiedTime ?? null,
            error: (e as Error).message,
          });
        }
      }
      pickCanonical(candidates);
      duplicates.push({ part_name: partName, candidate_count: candidates.length, candidates });
    }

    return new Response(JSON.stringify({ ok: true, duplicates }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
