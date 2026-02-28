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
async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const metadata: any = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) metadata.parents = [parentId];
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder: ${JSON.stringify(data)}`);
  return data.id;
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function uploadOrUpdate(token: string, fileName: string, content: string, folderId: string) {
  const existingId = await findFile(token, fileName, folderId);
  const boundary = "----DIDWriteBoundary";
  const metadata = JSON.stringify(
    existingId ? { name: fileName } : { name: fileName, parents: [folderId] }
  );

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive upload failed for ${fileName}: ${err}`);
  }
  return await res.json();
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
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
    const { updates } = await req.json();
    // updates: Array<{ fileName: string, content: string, mode: "append" | "replace" }>

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return new Response(JSON.stringify({ error: "No updates provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();

    // Find or create Kartoteka_DID folder
    let folderId = await findFolder(token, "Kartoteka_DID")
      || await findFolder(token, "Kartotéka_DID")
      || await findFolder(token, "KARTOTEKA_DID");

    if (!folderId) {
      folderId = await createFolder(token, "Kartoteka_DID");
      console.log("Created Kartoteka_DID folder:", folderId);
    }

    const results: Array<{ fileName: string; status: string }> = [];

    for (const update of updates) {
      const { fileName, content, mode: writeMode } = update;
      if (!fileName || !content) {
        results.push({ fileName: fileName || "unknown", status: "skipped - missing data" });
        continue;
      }

      try {
        if (writeMode === "append") {
          // Read existing content, append new content
          const existingId = await findFile(token, fileName, folderId);
          let existingContent = "";
          if (existingId) {
            existingContent = await readFileContent(token, existingId);
          }
          const newContent = existingContent 
            ? `${existingContent}\n\n${content}` 
            : content;
          await uploadOrUpdate(token, fileName, newContent, folderId);
        } else {
          // Replace entire file
          await uploadOrUpdate(token, fileName, content, folderId);
        }
        results.push({ fileName, status: "ok" });
      } catch (e) {
        console.error(`Failed to write ${fileName}:`, e);
        results.push({ fileName, status: `error: ${e.message}` });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("DID Drive write error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
