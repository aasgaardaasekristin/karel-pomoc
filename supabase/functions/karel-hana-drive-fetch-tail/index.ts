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
    const { file_ids, tail_lines, include_metadata, include_revisions } = await req.json();
    const ids: string[] = Array.isArray(file_ids) ? file_ids : [];
    const n = Math.max(1, Math.min(200, Number(tail_lines) || 15));
    const token = await getAccessToken();
    const auth_h = { Authorization: `Bearer ${token}` };
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const entry: Record<string, unknown> = {};
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
        { headers: auth_h },
      );
      if (!r.ok) { out[id] = { error: `HTTP ${r.status}: ${await r.text()}` }; continue; }
      const text = await r.text();
      const lines = text.split(/\r?\n/);
      entry.total_lines = lines.length;
      entry.total_chars = text.length;
      entry.tail = lines.slice(-n);
      if (include_metadata) {
        const m = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,version,createdTime,modifiedTime,modifiedByMe,lastModifyingUser&supportsAllDrives=true`,
          { headers: auth_h },
        );
        entry.metadata = m.ok ? await m.json() : { error: `HTTP ${m.status}: ${await m.text()}` };
      }
      if (include_revisions) {
        const rev = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}/revisions?fields=revisions(id,modifiedTime,size,lastModifyingUser,keepForever)`,
          { headers: auth_h },
        );
        entry.revisions = rev.ok ? await rev.json() : { error: `HTTP ${rev.status}: ${await rev.text()}` };
      }
      out[id] = entry;
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
