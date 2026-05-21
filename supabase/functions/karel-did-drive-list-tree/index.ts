// FIX 9.K.1c-PRE — Drive folder tree listing (KARTOTEKA_DID recursive)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const PER_FETCH_TIMEOUT_MS = 15_000;

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

async function findRootKartoteka(token: string): Promise<{ id: string; name: string } | null> {
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
    if (data.files?.[0]) return data.files[0];
  }
  return null;
}

async function listChildren(token: string, folderId: string) {
  const all: any[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType)",
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

async function walk(token: string, folderId: string, folderName: string, depth: number, maxDepth: number): Promise<any> {
  const children = await listChildren(token, folderId);
  const docs = children.filter(c => c.mimeType === DOC_MIME);
  const subfolders = children.filter(c => c.mimeType === FOLDER_MIME);
  const node: any = {
    folder_id: folderId,
    folder_name: folderName,
    depth,
    doc_count: docs.length,
    children: [] as any[],
  };
  if (depth < maxDepth) {
    for (const sf of subfolders) {
      node.children.push(await walk(token, sf.id, sf.name, depth + 1, maxDepth));
    }
  } else {
    node.children = subfolders.map(sf => ({
      folder_id: sf.id, folder_name: sf.name, depth: depth + 1, doc_count: null, children: [], truncated: true,
    }));
  }
  return node;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const maxDepth: number = typeof body.max_depth === "number" ? body.max_depth : 3;
    let rootFolderId: string | null = body.root_folder_id ?? null;
    let rootName = "KARTOTEKA_DID";

    const token = await getAccessToken();
    if (!rootFolderId) {
      const root = await findRootKartoteka(token);
      if (!root) {
        return new Response(JSON.stringify({ ok: false, error: "KARTOTEKA_DID root not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      rootFolderId = root.id;
      rootName = root.name;
    }
    const tree = await walk(token, rootFolderId, rootName, 0, maxDepth);
    return new Response(JSON.stringify({ ok: true, tree: [tree] }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
