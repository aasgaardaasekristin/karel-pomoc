import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder ${name}: ${JSON.stringify(data)}`);
  return data.id;
}

async function ensureFolder(token: string, name: string, parentId?: string): Promise<string> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return createFolder(token, name, parentId);
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (authHeader && !authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY")!)) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) throw new Error("Unauthorized");
    }

    const { pdfBase64, fileName, clientId, folder } = await req.json();

    if (!pdfBase64 || !fileName || !clientId || !folder) {
      throw new Error("Missing required fields: pdfBase64, fileName, clientId, folder");
    }

    const validFolders = ["Sezeni", "Plany", "Asistence"];
    if (!validFolders.includes(folder)) {
      throw new Error(`Invalid folder: ${folder}. Must be one of: ${validFolders.join(", ")}`);
    }

    const token = await getAccessToken();

    // Ensure folder structure: ZALOHA / {clientId} / {folder}
    const zalohaId = await ensureFolder(token, "ZALOHA");
    const clientFolderId = await ensureFolder(token, clientId, zalohaId);
    const targetFolderId = await ensureFolder(token, folder, clientFolderId);

    // Decode base64 to binary
    const binaryString = atob(pdfBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Check if file already exists (update instead of duplicate)
    const existingId = await findFile(token, fileName, targetFolderId);

    const boundary = "----SessionBackupBoundary";
    const metadata = JSON.stringify(
      existingId
        ? { name: fileName }
        : { name: fileName, parents: [targetFolderId] }
    );

    // Build multipart body
    const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
    const filePart = `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
    const closing = `\r\n--${boundary}--`;

    const encoder = new TextEncoder();
    const metaBytes = encoder.encode(metaPart);
    const filePartBytes = encoder.encode(filePart);
    const closingBytes = encoder.encode(closing);

    const body = new Uint8Array(metaBytes.length + filePartBytes.length + bytes.length + closingBytes.length);
    body.set(metaBytes, 0);
    body.set(filePartBytes, metaBytes.length);
    body.set(bytes, metaBytes.length + filePartBytes.length);
    body.set(closingBytes, metaBytes.length + filePartBytes.length + bytes.length);

    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&supportsAllDrives=true`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;

    const uploadRes = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Drive upload failed: ${err}`);
    }

    const uploadData = await uploadRes.json();
    console.log(`[session-drive-backup] Uploaded ${fileName} to ZALOHA/${clientId}/${folder} (id: ${uploadData.id})`);

    return new Response(JSON.stringify({
      success: true,
      fileId: uploadData.id,
      fileName,
      folder: `ZALOHA/${clientId}/${folder}`,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("[session-drive-backup] Error:", e);
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
