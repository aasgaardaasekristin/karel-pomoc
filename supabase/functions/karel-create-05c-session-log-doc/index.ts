/**
 * karel-create-05c-session-log-doc
 *
 * One-off narrow governance operation:
 * - creates only KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG when missing
 * - does not touch pantry packages or drive write queue
 * - does not run processors or broad batches
 */

import {
  FOLDER_MIME,
  GDOC_MIME,
  findFolder,
  getAccessToken,
  listFiles,
  resolveKartotekaRoot,
} from "../_shared/driveHelpers.ts";
import { isGovernedTarget } from "../_shared/documentGovernance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TARGET_NAME = "05C_SEZENI_LOG";
const TARGET_PATH = "KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG";
const TARGET_FOLDER = "KARTOTEKA_DID/00_CENTRUM";
const INITIAL_CONTENT = `# 05C_SEZENI_LOG

Tento dokument je centrální auditní log terapeutických sezení DID systému.

Slouží k lidsky čitelné dokumentaci:
- kdy sezení proběhlo,
- s jakou částí,
- kdo ho vedl,
- v jakém rozsahu proběhlo,
- jaký byl výsledek,
- jaké jsou implikace pro další práci.

Tento dokument není runtime source of truth.
Primární runtime záznamy jsou v databázi, zejména \`did_session_reviews\`, session plans a související evidence.

Zápisy do tohoto dokumentu musí být dedukční a stručné.
Nepatří sem syrový transcript.
`;

type ResolvedDoc = { id: string; name: string; mimeType?: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function exactDoc(files: ResolvedDoc[]): ResolvedDoc | null {
  return files.find((file) => file.mimeType !== FOLDER_MIME && file.name === TARGET_NAME) ?? null;
}

async function createGoogleDoc(token: string, folderId: string): Promise<ResolvedDoc> {
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: TARGET_NAME, parents: [folderId], mimeType: GDOC_MIME }),
  });
  if (!createRes.ok) {
    throw new Error(`Drive create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = await createRes.json();

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${created.id}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: INITIAL_CONTENT } }] }),
  });
  if (!updateRes.ok) {
    throw new Error(`Docs initial content insert failed: ${updateRes.status} ${await updateRes.text()}`);
  }

  return { id: created.id, name: created.name ?? TARGET_NAME, mimeType: created.mimeType ?? GDOC_MIME };
}

async function resolveTarget(token: string, kartotekaRoot: string): Promise<ResolvedDoc | null> {
  const centrumFolder = await findFolder(token, "00_CENTRUM", kartotekaRoot);
  if (!centrumFolder) return null;
  return exactDoc(await listFiles(token, centrumFolder));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    if (!isGovernedTarget(TARGET_PATH)) {
      return json({ ok: false, error: "Governance target is not explicitly whitelisted", target_path: TARGET_PATH }, 500);
    }

    const token = await getAccessToken();
    const kartotekaRoot = await resolveKartotekaRoot(token);
    if (!kartotekaRoot) return json({ ok: false, error: "KARTOTEKA_DID root not found" }, 404);

    const centrumFolder = await findFolder(token, "00_CENTRUM", kartotekaRoot);
    if (!centrumFolder) return json({ ok: false, error: "00_CENTRUM folder not found", folder: TARGET_FOLDER }, 404);

    const before = exactDoc(await listFiles(token, centrumFolder));
    const doc = before ?? await createGoogleDoc(token, centrumFolder);
    const resolved = await resolveTarget(token, kartotekaRoot);

    return json({
      ok: true,
      created: before ? false : true,
      file_id: doc.id,
      file_name: doc.name,
      path: TARGET_PATH,
      folder: TARGET_FOLDER,
      resolver_found: resolved?.id === doc.id,
      resolver_file_id: resolved?.id ?? null,
      governance_exact: isGovernedTarget(TARGET_PATH),
      processors_run: false,
      package_touched: false,
      queue_touched: false,
    });
  } catch (e: any) {
    console.error("[create-05c-session-log-doc] fatal:", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});
