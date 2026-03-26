import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(): Promise<string> {
  const keyJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
  if (!keyJson) throw new Error("No service account key");
  const key = JSON.parse(keyJson);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const enc = new TextEncoder();
  const importedKey = await crypto.subtle.importKey(
    "pkcs8",
    (() => { const b = atob(key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; })(),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", importedKey, enc.encode(`${header}.${claim}`)));
  const jwt = `${header}.${claim}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  return d.access_token;
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

async function readDoc(token: string, name: string, folderId: string): Promise<string> {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  const f = d.files?.[0];
  if (!f) return "(soubor nenalezen)";
  if (f.mimeType === "application/vnd.google-apps.document") {
    const cr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return await cr.text();
  }
  const cr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return await cr.text();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { folders } = await req.json(); // e.g. ["Hanka", "Kata"]
    const token = await getAccessToken();
    const pamet = await findFolder(token, "PAMET_KAREL");
    if (!pamet) throw new Error("PAMET_KAREL not found");
    const did = await findFolder(token, "DID", pamet);
    if (!did) throw new Error("DID not found");

    const files = ["SITUACNI_ANALYZA.txt", "VLAKNA_POSLEDNI.txt", "PROFIL_OSOBNOSTI.txt", "STRATEGIE_KOMUNIKACE.txt", "KARLOVY_POZNATKY.txt"];
    const result: Record<string, Record<string, string>> = {};
    
    for (const folder of (folders || ["Hanka", "Kata"])) {
      const fId = await findFolder(token, folder, did);
      if (!fId) { result[folder] = { error: "folder not found" }; continue; }
      result[folder] = {};
      for (const file of files) {
        result[folder][file] = await readDoc(token, file, fId);
      }
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
