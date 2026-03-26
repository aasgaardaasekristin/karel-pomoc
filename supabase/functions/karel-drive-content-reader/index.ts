const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(): Promise<string> {
  // Try user refresh token first (same as other Drive functions)
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  
  if (clientId && clientSecret && refreshToken) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const d = await r.json();
    if (d.access_token) return d.access_token;
  }
  throw new Error("No valid auth method");
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

async function readDoc(token: string, name: string, folderId: string): Promise<string> {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  const f = d.files?.[0];
  if (!f) return "(soubor nenalezen)";
  let cr;
  if (f.mimeType === "application/vnd.google-apps.document") {
    cr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } else {
    cr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  return await cr.text();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const token = await getAccessToken();
    
    // Debug: list root to find PAMET_KAREL
    if (body.listRoot) {
      const q = `mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      return new Response(JSON.stringify(d.files), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { folders, files: requestedFiles } = body;
    const pamet = await findFolder(token, "PAMET_KAREL");
    if (!pamet) throw new Error("PAMET_KAREL not found");
    const did = await findFolder(token, "DID", pamet);
    if (!did) throw new Error("DID not found in PAMET_KAREL");

    const files = requestedFiles || ["SITUACNI_ANALYZA.txt", "VLAKNA_POSLEDNI.txt"];
    const result: Record<string, Record<string, { content: string; length: number }>> = {};
    
    for (const folder of (folders || ["HANKA", "KATA"])) {
      const fId = await findFolder(token, folder, did);
      if (!fId) { result[folder] = { error: { content: "folder not found", length: 0 } }; continue; }
      result[folder] = {};
      for (const file of files) {
        const content = await readDoc(token, file, fId);
        result[folder][file] = { content, length: content.length };
      }
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
