/**
 * karel-jung-original-fetch
 *
 * On-demand reader Karlovy „minulé inkarnace" pro injekci do system promptů
 * v `karel-chat` a `karel-hana-chat`. Vrací obsah 3 dokumentů v
 * `PAMET_KAREL/ORIGINAL/`. Cache: 6h v `karel_working_memory_snapshots`
 * pod typem `jung_original_cache`.
 *
 * Vstup:
 *   { force?: boolean }   — true = bypass cache
 *
 * Výstup:
 *   {
 *     ok: true,
 *     character: string,
 *     memories:  string,
 *     knowledge: string,
 *     fetched_at: ISO,
 *     from_cache: boolean,
 *   }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CACHE_KIND = "jung_original_cache";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const DOC_KEYS = ["CHARAKTER_JUNGA", "VZPOMINKY_ZIVOT", "ZNALOSTI_DILA"] as const;
type DocKey = typeof DOC_KEYS[number];

// ── OAuth2 token helper (zkopírováno z karel-did-drive-read pattern) ──
async function getDriveToken(): Promise<string> {
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
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Drive token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({
    q, fields: "files(id)", pageSize: "5",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function findFile(token: string, name: string, parentId: string): Promise<{ id: string; mimeType?: string } | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,mimeType)", pageSize: "5" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0] ?? null;
}

async function readDocText(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isGoogleDoc = mimeType === "application/vnd.google-apps.document";
  if (isGoogleDoc) {
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!exportRes.ok) return "";
    return await exportRes.text();
  }
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return "";
  return await res.text();
}

async function fetchAllDocsFromDrive(): Promise<Record<DocKey, string>> {
  const token = await getDriveToken();
  const pametId = await findFolder(token, "PAMET_KAREL");
  if (!pametId) throw new Error("PAMET_KAREL folder not found on Drive");
  const originalId = await findFolder(token, "ORIGINAL", pametId);
  if (!originalId) throw new Error("PAMET_KAREL/ORIGINAL/ folder not found — spusť bootstrap nejdřív.");

  const out: Partial<Record<DocKey, string>> = {};
  for (const key of DOC_KEYS) {
    // Try several name variants (Google Docs may strip extension)
    const variants = [key, `${key}.md`, `${key}.txt`];
    let found = "";
    for (const v of variants) {
      const file = await findFile(token, v, originalId);
      if (file) {
        found = await readDocText(token, file.id, file.mimeType);
        if (found.trim()) break;
      }
    }
    out[key] = found;
  }
  return out as Record<DocKey, string>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const force = Boolean(body?.force);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Cache lookup ──
    if (!force) {
      const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
      const { data: cached } = await (admin as any)
        .from("karel_working_memory_snapshots")
        .select("snapshot, created_at")
        .eq("snapshot_kind", CACHE_KIND)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cached?.snapshot) {
        return new Response(JSON.stringify({
          ok: true,
          ...cached.snapshot,
          fetched_at: cached.created_at,
          from_cache: true,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── Fresh fetch from Drive ──
    const docs = await fetchAllDocsFromDrive();
    const payload = {
      character: docs.CHARAKTER_JUNGA ?? "",
      memories:  docs.VZPOMINKY_ZIVOT ?? "",
      knowledge: docs.ZNALOSTI_DILA ?? "",
    };

    // Persist cache (best-effort)
    try {
      await (admin as any).from("karel_working_memory_snapshots").insert({
        snapshot_kind: CACHE_KIND,
        snapshot: payload,
      });
    } catch (cacheErr) {
      console.warn("[jung-fetch] cache insert failed:", cacheErr);
    }

    return new Response(JSON.stringify({
      ok: true,
      ...payload,
      fetched_at: new Date().toISOString(),
      from_cache: false,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[jung-fetch] failed:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
