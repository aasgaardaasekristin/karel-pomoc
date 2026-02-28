import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// ── OAuth2 token helper ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth credentials");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
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

// ── Drive helpers ──
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  // Try plain text export first, fall back to media download
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    // Maybe it's a Google Doc – try export
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { documents, listAll } = await req.json();
    const token = await getAccessToken();

    // Find Kartotéka_DID folder
    const folderId = await findFolder(token, "Kartoteka_DID") 
      || await findFolder(token, "Kartotéka_DID")
      || await findFolder(token, "KARTOTEKA_DID");

    if (!folderId) {
      return new Response(JSON.stringify({ 
        error: "Složka Kartoteka_DID nebyla nalezena na Google Drive",
        documents: {} 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If listAll is true, return list of all files in the folder
    if (listAll) {
      const files = await listFilesInFolder(token, folderId);
      return new Response(JSON.stringify({ files, folderId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read requested documents
    const files = await listFilesInFolder(token, folderId);
    const result: Record<string, string> = {};
    const requestedDocs: string[] = documents || ["00_Seznam_casti", "01_Hlavni_mapa_systemu"];

    for (const docName of requestedDocs) {
      // Find file by partial name match (case-insensitive)
      const normalizedDocName = docName.toLowerCase().replace(/[_\s-]/g, "");
      const match = files.find(f => {
        const normalizedFileName = f.name.toLowerCase().replace(/[_\s-]/g, "").replace(/\.(txt|md|doc|docx)$/i, "");
        return normalizedFileName.includes(normalizedDocName) || normalizedDocName.includes(normalizedFileName);
      });

      if (match) {
        try {
          result[docName] = await readFileContent(token, match.id);
        } catch (e) {
          console.error(`Failed to read ${docName} (${match.name}):`, e);
          result[docName] = `[Chyba při čtení: ${e.message}]`;
        }
      } else {
        result[docName] = `[Dokument "${docName}" nebyl nalezen ve složce Kartoteka_DID]`;
      }
    }

    return new Response(JSON.stringify({ documents: result, folderId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DID Drive read error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
