import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

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
  return (await res.json()).access_token;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

async function listFiles(token: string, folderId: string) {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).files || [];
}

async function readContent(token: string, fileId: string, mimeType: string): Promise<string> {
  if (mimeType === DOC_MIME) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? await res.text() : `ERR_${res.status}`;
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? await res.text() : `ERR_${res.status}`;
}

const SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    await requireAuth(req);
    const token = await getAccessToken();

    // Find root
    const q = `name='kartoteka_DID' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const rootId = ((await (await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } })).json()).files?.[0]?.id);

    const rootChildren = await listFiles(token, rootId);
    const folders = rootChildren.filter((f: any) => f.mimeType === FOLDER_MIME);
    const activeId = folders.find((f: any) => /^01/.test(f.name))?.id;
    const archiveId = folders.find((f: any) => /^03/.test(f.name))?.id;

    const cards: any[] = [];

    // Read first few files in active + archive
    for (const [folderId, label] of [[activeId, "AKTIVNI"], [archiveId, "ARCHIV"]] as [string, string][]) {
      if (!folderId) continue;
      const files = await listFiles(token, folderId);
      let count = 0;
      for (const f of files) {
        if (f.mimeType === FOLDER_MIME) continue;
        if (count >= 1) break;
        count++;
        try {
          const content = await readContent(token, f.id, f.mimeType);
          const found = SECTIONS.filter(s => content.includes(`SEKCE ${s}`));
          const hasHeader = /KARTA\s+(ČÁSTI|CASTI|CAST)/i.test(content);
          cards.push({
            name: f.name,
            folder: label,
            mimeType: f.mimeType,
            contentLen: content.length,
            sectionsFound: found,
            sectionsMissing: SECTIONS.filter(s => !found.includes(s)),
            hasKartaHeader: hasHeader,
            first400: content.slice(0, 400),
          });
        } catch (e) {
          cards.push({ name: f.name, folder: label, error: String(e) });
        }
      }
    }

    const correct = cards.filter(c => c.sectionsMissing?.length === 0);
    const partial = cards.filter(c => c.sectionsFound?.length > 0 && c.sectionsMissing?.length > 0);
    const none = cards.filter(c => c.sectionsFound?.length === 0);

    return new Response(JSON.stringify({
      totalCards: cards.length,
      correct: correct.length,
      partial: partial.length,
      noSections: none.length,
      cards,
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
