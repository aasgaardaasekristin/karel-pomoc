/**
 * karel-hana-smoke8-ops — admin utility pro Smoke Test 8 (kroky 2, 4, 5).
 * Akce přes JSON body: { action: "append_marker" | "trigger_context_prime" | "verify_drive" }
 * Auth: requireAuth (uživatelský JWT).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const VLAKNA_FILE_ID = "17fY79Eg43-OYi4-V2rnmndnkdGBiDcqp";

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

async function driveMetadata(token: string, fileId: string) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,version,size,modifiedTime,createdTime&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return r.ok ? await r.json() : { error: `HTTP ${r.status}: ${await r.text()}` };
}

async function driveDownload(token: string, fileId: string): Promise<string> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Drive download HTTP ${r.status}: ${await r.text()}`);
  return r.text();
}

async function driveUpload(token: string, fileId: string, text: string) {
  const r = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    },
  );
  if (!r.ok) throw new Error(`Drive upload HTTP ${r.status}: ${await r.text()}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const { action } = await req.json();
    const token = await getAccessToken();

    if (action === "append_marker") {
      const ts = new Date().toISOString();
      const marker = `SORTER_TEST_MARKER ${ts}`;
      const existing = await driveDownload(token, VLAKNA_FILE_ID);
      const updated = existing + (existing.endsWith("\n") ? "" : "\n") + marker + "\n";
      await driveUpload(token, VLAKNA_FILE_ID, updated);
      const meta = await driveMetadata(token, VLAKNA_FILE_ID);
      return new Response(JSON.stringify({
        ok: true, action, marker_written: marker,
        bytes_before: existing.length, bytes_after: updated.length,
        drive_metadata_after: meta,
      }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "trigger_context_prime") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const t0 = Date.now();
      const resp = await fetch(`${supabaseUrl}/functions/v1/karel-did-context-prime`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          apikey: serviceKey,
        },
        body: JSON.stringify({ therapist: "hanka", forceRefresh: true }),
      });
      const duration_ms = Date.now() - t0;
      const text = await resp.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep raw */ }
      return new Response(JSON.stringify({
        ok: resp.ok, action, status: resp.status, duration_ms, response: body,
      }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "verify_drive") {
      const meta = await driveMetadata(token, VLAKNA_FILE_ID);
      const content = await driveDownload(token, VLAKNA_FILE_ID);
      const lines = content.split(/\r?\n/);
      const hasMarker = /SORTER_TEST_MARKER 2026-05-19/.test(content);
      const hasTundrupek = /Tundrupek dnes p\u0159epnul/.test(content);
      return new Response(JSON.stringify({
        ok: true, action,
        drive_metadata: meta,
        total_lines: lines.length,
        total_chars: content.length,
        contains_SORTER_TEST_MARKER_2026_05_19: hasMarker,
        contains_Tundrupek_dnes_prepnul: hasTundrupek,
        first_50_lines: lines.slice(0, 50),
      }, null, 2), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error)?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
