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
async function findFolders(token: string, name: string, parentId?: string): Promise<Array<{ id: string }>> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const params = new URLSearchParams({
    q,
    fields: "files(id)",
    pageSize: "20",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  const folders = await findFolders(token, name, parentId);
  return folders[0]?.id || null;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const rootVariants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];

  for (const rootName of rootVariants) {
    const candidates = await findFolders(token, rootName);

    for (const candidate of candidates) {
      const centrumId = await findFolder(token, "00_CENTRUM", candidate.id);
      const aktivniId = await findFolder(token, "01_AKTIVNI_FRAGMENTY", candidate.id);
      if (centrumId || aktivniId) return candidate.id;
    }

    if (candidates[0]?.id) return candidates[0].id;
  }

  return null;
}

async function listFilesInFolder(
  token: string,
  folderId: string
): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return allFiles;
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

const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const canonicalDocName = (value: string) => {
  const normalized = stripDiacritics(value)
    .toLowerCase()
    .replace(/\.(txt|md|doc|docx)$/i, "")
    .replace(/[\s_-]/g, "")
    .replace(/^karta/, "")
    .replace(/^\d+/, "");

  return normalized;
};

const isDocumentMatch = (requested: string, fileName: string) => {
  const requestedCanonical = canonicalDocName(requested);
  const fileCanonical = canonicalDocName(fileName);

  if (!requestedCanonical || !fileCanonical) return false;

  return (
    requestedCanonical === fileCanonical ||
    requestedCanonical.includes(fileCanonical) ||
    fileCanonical.includes(requestedCanonical)
  );
};

async function findDocumentRecursive(
  token: string,
  folderId: string,
  requestedDoc: string
): Promise<{ id: string; name: string; mimeType?: string } | null> {
  const files = await listFilesInFolder(token, folderId);

  const directMatch = files.find(
    (f) => f.mimeType !== "application/vnd.google-apps.folder" && isDocumentMatch(requestedDoc, f.name)
  );
  if (directMatch) return directMatch;

  const subfolders = files.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
  for (const subfolder of subfolders) {
    const nestedMatch = await findDocumentRecursive(token, subfolder.id, requestedDoc);
    if (nestedMatch) return nestedMatch;
  }

  return null;
}

async function findDocumentGlobal(
  token: string,
  requestedDoc: string
): Promise<{ id: string; name: string; mimeType?: string } | null> {
  const canonical = canonicalDocName(requestedDoc);
  const searchTerm = canonical.replace(/^\d+/, "").slice(0, 40) || requestedDoc;

  const q = `trashed=false and mimeType!='application/vnd.google-apps.folder' and name contains '${searchTerm}'`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const files = (data.files || []) as Array<{ id: string; name: string; mimeType?: string }>;

  return files.find((f) => isDocumentMatch(requestedDoc, f.name)) || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { documents, listAll, subFolder, allowGlobalSearch } = await req.json();
    const token = await getAccessToken();

    // Find kartoteka_DID folder
    const rootFolderId = await resolveKartotekaRoot(token);

    if (!rootFolderId) {
      return new Response(JSON.stringify({ 
        error: "Složka Kartoteka_DID nebyla nalezena na Google Drive",
        documents: {} 
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve target folder (root or subfolder)
    let targetFolderId = rootFolderId;
    if (subFolder) {
      const subFolderId = await findFolder(token, subFolder, rootFolderId);
      if (subFolderId) {
        targetFolderId = subFolderId;
      } else {
        console.warn(`Subfolder "${subFolder}" not found in Kartoteka_DID, using root`);
      }
    }

    // If listAll is true, return list of all files in the target folder
    if (listAll) {
      const files = await listFilesInFolder(token, targetFolderId);
      return new Response(JSON.stringify({ files, folderId: targetFolderId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read requested documents — search recursively through all subfolders
    const result: Record<string, string> = {};
    const requestedDocs: string[] = documents || [];

    for (const docName of requestedDocs) {
      // Search recursively from the target folder
      let match = await findDocumentRecursive(token, targetFolderId, docName);
      if (!match) {
        // Fall back to global search
        match = await findDocumentGlobal(token, docName);
      }

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

    return new Response(JSON.stringify({ documents: result, folderId: targetFolderId }), {
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
