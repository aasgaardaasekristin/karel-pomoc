/**
 * karel-hana-drive-fetch-tail — admin utility (FIX 8.4 verifikace)
 * Stáhne text/plain Drive soubor podle file_id a vrátí posledních N řádků.
 * Auth: requireAuth (JWT uživatele).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;
  try {
    const { file_ids, tail_lines } = await req.json();
    const ids: string[] = Array.isArray(file_ids) ? file_ids : [];
    const n = Math.max(1, Math.min(200, Number(tail_lines) || 15));
    const token = await getAccessToken();
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) { out[id] = { error: `HTTP ${r.status}: ${await r.text()}` }; continue; }
      const text = await r.text();
      const lines = text.split(/\r?\n/);
      out[id] = { total_lines: lines.length, total_chars: text.length, tail: lines.slice(-n) };
    }
    return new Response(JSON.stringify({ ok: true, files: out }, null, 2), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error)?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
