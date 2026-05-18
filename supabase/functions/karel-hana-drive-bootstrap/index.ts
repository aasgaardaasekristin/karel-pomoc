/**
 * karel-hana-drive-bootstrap (FIX 8.4)
 *
 * Idempotentně vytvoří chybějící text-plain soubory ve složce
 * Drive: PAMET_KAREL/DID/HANKA/.
 *
 * Soubory vytváří jako `text/plain` (NE Google Doc) s minimálním
 * bootstrap headerem. Pokud soubor stejného jména ve složce už
 * existuje (jakýkoliv mimeType), je přeskočen.
 *
 * KAREL (bare, bez .txt) — existující Google Doc — se nikdy nemaže
 * ani neduplikuje. Pre-Flight Karla potvrdil existenci 5/7 souborů;
 * tento bootstrap doplní zbytek bez ohledu na pre-flight (idempotent).
 *
 * Auth: requireAuth (JWT uživatele) — nesmí být veřejné.
 * Žádný side effect mimo Drive `files.create` v jediné složce.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const TEXT_MIME = "text/plain";

const BOOTSTRAP_FILES: ReadonlyArray<{ name: string; header: string }> = [
  {
    name: "KAREL.txt",
    header:
      "# KAREL.txt — Karlovy osobní zápisky pro Hanku\n" +
      "Bootstrap FIX 8.4 — soubor rezervován pro budoucí karel_self_note (8.6).\n",
  },
  {
    name: "KDO_JE_KDO.txt",
    header:
      "# KDO_JE_KDO.txt — Lidé v Hančině kontextu (Káťa, rodina, kolegové)\n" +
      "Bootstrap FIX 8.4 — cílový soubor pro segmenty label=team_about_kata.\n",
  },
  {
    name: "KARLOVY_POZNATKY.txt",
    header:
      "# KARLOVY_POZNATKY.txt — Karlovy meta-poznatky o průběhu spolupráce\n" +
      "Bootstrap FIX 8.4 — cílový soubor pro segmenty label=meta_to_karel.\n",
  },
  {
    name: "SITUACNI_ANALYZA.txt",
    header:
      "# SITUACNI_ANALYZA.txt — Hančin osobní stav, tělo, situace\n" +
      "Bootstrap FIX 8.4 — cílový soubor pro segmenty label=intimate_self.\n",
  },
  {
    name: "VLAKNA_POSLEDNI.txt",
    header:
      "# VLAKNA_POSLEDNI.txt — Poslední vlákna o DID a logistice\n" +
      "Bootstrap FIX 8.4 — cílový soubor pro segmenty label=team_about_did / team_logistics.\n",
  },
];

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
  return data.access_token as string;
}

async function findFolderByName(
  token: string,
  name: string,
  parentId: string | null,
): Promise<string | null> {
  const safeName = name.replace(/'/g, "\\'");
  const parts = [
    `name='${safeName}'`,
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    "trashed=false",
  ];
  if (parentId) parts.push(`'${parentId}' in parents`);
  const params = new URLSearchParams({
    q: parts.join(" and "),
    fields: "files(id,name)",
    pageSize: "10",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`folder lookup failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function listFilesInFolder(
  token: string,
  folderId: string,
): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType)",
    pageSize: "200",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`folder list failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.files || [];
}

async function createTextFile(
  token: string,
  folderId: string,
  name: string,
  content: string,
): Promise<string> {
  const boundary = "----HanaBootstrapBoundary";
  const metadata = JSON.stringify({
    name,
    parents: [folderId],
    mimeType: TEXT_MIME,
  });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${TEXT_MIME}; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`create ${name} failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.id as string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const token = await getAccessToken();

    const pametId = await findFolderByName(token, "PAMET_KAREL", null);
    if (!pametId) {
      return new Response(
        JSON.stringify({ ok: false, error: "PAMET_KAREL folder not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const didId = await findFolderByName(token, "DID", pametId);
    if (!didId) {
      return new Response(
        JSON.stringify({ ok: false, error: "PAMET_KAREL/DID folder not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const hankaId = await findFolderByName(token, "HANKA", didId);
    if (!hankaId) {
      return new Response(
        JSON.stringify({ ok: false, error: "PAMET_KAREL/DID/HANKA folder not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const existing = await listFilesInFolder(token, hankaId);
    const existingNames = new Set(existing.map((f) => f.name));

    const report: Array<{ name: string; action: "created" | "skipped"; id?: string; reason?: string }> = [];
    for (const f of BOOTSTRAP_FILES) {
      if (existingNames.has(f.name)) {
        report.push({ name: f.name, action: "skipped", reason: "already_exists" });
        continue;
      }
      try {
        const id = await createTextFile(token, hankaId, f.name, f.header);
        report.push({ name: f.name, action: "created", id });
      } catch (e) {
        report.push({ name: f.name, action: "skipped", reason: `create_failed: ${(e as Error)?.message}` });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        marker: "fix_8_4_hana_drive_bootstrap_v8.4.0",
        folder_id: hankaId,
        created: report.filter((r) => r.action === "created").length,
        skipped: report.filter((r) => r.action === "skipped").length,
        report,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[karel-hana-drive-bootstrap] error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error)?.message ?? String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
