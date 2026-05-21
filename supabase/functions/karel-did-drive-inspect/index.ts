// FIX 9.K.1c-PRE — Drive folder listing + doc peek (names/ids + first N lines)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
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

async function listFolderDocs(token: string, folderId: string) {
  const all: any[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.document'`,
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    all.push(...(data.files || []).map((f: any) => ({ file_id: f.id, name: f.name })));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

async function peekDoc(token: string, fileId: string, n: number): Promise<string[]> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`export ${fileId}: ${res.status}`);
  const text = await res.text();
  return text.split("\n").slice(0, n);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const folderIds: Record<string, string> = body.folders || {};
    const peeks: { file_id: string; label?: string }[] = body.peek_docs || [];
    const peekLines: number = body.peek_lines || 60;

    const token = await getAccessToken();
    const listings: Record<string, any[]> = {};
    for (const [label, fid] of Object.entries(folderIds)) {
      listings[label] = await listFolderDocs(token, fid);
    }
    const peeked: any[] = [];
    for (const p of peeks) {
      try {
        const lines = await peekDoc(token, p.file_id, peekLines);
        peeked.push({ file_id: p.file_id, label: p.label, line_count_returned: lines.length, lines });
      } catch (e) {
        peeked.push({ file_id: p.file_id, label: p.label, error: (e as Error).message });
      }
    }
    return new Response(JSON.stringify({ ok: true, listings, peeked }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
