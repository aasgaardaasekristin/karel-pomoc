import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Google auth helpers ──

async function getAccessToken(key: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = btoa(JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const encoder = new TextEncoder();
  const signInput = encoder.encode(`${header}.${claim}`);

  const pemContent = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, signInput);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const jwt = `${header}.${claim}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
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
  const boundary = "----BackupBoundary";
  const metadata = JSON.stringify(
    existingId
      ? { name: fileName }
      : { name: fileName, parents: [folderId] }
  );

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
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

// ── Main ──

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth: support both user token (manual) and service role (cron)
    const authHeader = req.headers.get("Authorization");
    
    // Use service role for cron or when called without user auth
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // If user token provided, verify it; for cron we skip this
    if (authHeader && !authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY")!)) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) throw new Error("Unauthorized");
    }

    // Load ALL clients data (service role bypasses RLS)
    const [clientsRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("client_sessions").select("*").order("session_date", { ascending: false }),
      supabase.from("client_tasks").select("*").order("created_at", { ascending: false }),
    ]);

    const clients = clientsRes.data || [];
    const allSessions = sessionsRes.data || [];
    const allTasks = tasksRes.data || [];

    // Google auth
    const keyStr = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!keyStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    const serviceKey = JSON.parse(keyStr);
    const token = await getAccessToken(serviceKey);

    // Find KARTOTEKA folder
    const kartotekaId = await findFolder(token, "KARTOTEKA");
    if (!kartotekaId) throw new Error("Složka KARTOTEKA nebyla nalezena na Drive. Zkontroluj sdílení.");

    // Upload one JSON file per client
    let uploaded = 0;
    for (const client of clients) {
      const clientSessions = allSessions.filter((s: any) => s.client_id === client.id);
      const clientTasks = allTasks.filter((t: any) => t.client_id === client.id);

      const payload = {
        _backup_date: new Date().toISOString(),
        client,
        sessions: clientSessions,
        tasks: clientTasks,
      };

      const safeName = client.name.replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ _-]/g, "_");
      const fileName = `${safeName}.json`;
      await uploadOrUpdate(token, fileName, JSON.stringify(payload, null, 2), kartotekaId);
      uploaded++;
    }

    return new Response(JSON.stringify({
      success: true,
      message: `✅ Zálohováno ${uploaded} klientů do složky KARTOTEKA.`,
      clients_count: uploaded,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
