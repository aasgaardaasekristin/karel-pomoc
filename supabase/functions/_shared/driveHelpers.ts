/**
 * Shared Google Drive helpers used across edge functions:
 * cleanup-part-card, update-part-card, run-daily-card-updates
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const GDOC_MIME = "application/vnd.google-apps.document";

export type DriveFile = { id: string; name: string; mimeType?: string };

export async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function listFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

export async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

export async function resolveKartotekaRoot(token: string): Promise<string | null> {
  for (const name of ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

export async function readFileContent(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isWorkspace = mimeType?.startsWith("application/vnd.google-apps.");
  if (isWorkspace) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Export failed: ${r.status}`);
    return r.text();
  }
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    // Fallback: try export
    const exportR = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!exportR.ok) throw new Error(`Cannot read file ${fileId}: ${exportR.status}`);
    return exportR.text();
  }
  return r.text();
}

export async function overwriteDoc(token: string, fileId: string, newContent: string): Promise<void> {
  const metaRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Docs API meta failed: ${metaRes.status}`);
  const meta = await metaRes.json();
  const content = meta?.body?.content || [];
  const lastEnd = content.length > 0 ? Number(content[content.length - 1]?.endIndex || 1) : 1;

  const requests: any[] = [];
  if (lastEnd > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: lastEnd - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: newContent } });

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs overwrite failed: ${res.status} ${errText}`);
  }
  await res.text();
}

export async function appendToDoc(token: string, fileId: string, text: string): Promise<void> {
  const metaRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Docs API endIndex failed: ${metaRes.status}`);
  const meta = await metaRes.json();
  const content = meta?.body?.content || [];
  const lastEnd = content.length > 0 ? Number(content[content.length - 1]?.endIndex || 1) : 1;
  const insertAt = Math.max(lastEnd - 1, 1);

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: insertAt }, text } }] }),
  });
  if (!res.ok) throw new Error(`Docs append failed: ${res.status}`);
  await res.text();
}

export async function createBackup(token: string, folderId: string, originalName: string, content: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const backupName = `BACKUP_${date}_${originalName}`;
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: backupName, parents: [folderId], mimeType: GDOC_MIME }),
  });
  if (!createRes.ok) throw new Error(`Backup create failed: ${createRes.status}`);
  const newFile = await createRes.json();
  await fetch(`https://docs.googleapis.com/v1/documents/${newFile.id}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
  });
  console.log(`[driveHelpers] Backup created: ${backupName} (${newFile.id})`);
  return newFile.id;
}

export async function findCardFileInFolder(token: string, folderId: string): Promise<DriveFile | null> {
  const files = await listFiles(token, folderId);
  return files.find(f =>
    f.mimeType !== FOLDER_MIME &&
    !f.name.startsWith("BACKUP_") &&
    !f.name.includes("ARCHIV") &&
    (f.mimeType === GDOC_MIME || /\.(txt|md)$/i.test(f.name))
  ) || null;
}

export async function moveFile(token: string, fileId: string, newParentId: string, removeParentId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${removeParentId}&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Move file failed: ${res.status}`);
}

export async function findFileByName(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name contains '${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

/** Append text to a plain-text (non-Google-Docs) file on Drive. */
export async function appendToFile(token: string, fileId: string, text: string): Promise<void> {
  // 1. Download current content
  const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!dlRes.ok) throw new Error(`appendToFile download failed: ${dlRes.status}`);
  const existing = await dlRes.text();

  // 2. Append new text
  const updated = existing + text;

  // 3. Upload back via PATCH
  const upRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: updated,
    },
  );
  if (!upRes.ok) {
    const errText = await upRes.text();
    throw new Error(`appendToFile upload failed: ${upRes.status} ${errText}`);
  }
}

/** Replace entire content of a plain-text file on Drive. */
export async function replaceFile(token: string, fileId: string, text: string): Promise<void> {
  const upRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: text,
    },
  );
  if (!upRes.ok) {
    const errText = await upRes.text();
    throw new Error(`replaceFile upload failed: ${upRes.status} ${errText}`);
  }
}
