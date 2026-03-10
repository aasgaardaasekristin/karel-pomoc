import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(): Promise<string> {
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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";

const canonicalText = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

async function listFilesInFolder(token: string, folderId: string) {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).files || [];
}

async function findFolder(token: string, name: string) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).files?.[0]?.id || null;
}

async function moveFile(token: string, fileId: string, newParent: string, oldParent: string) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParent}&removeParents=${oldParent}&supportsAllDrives=true`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }
  );
  if (!res.ok) throw new Error(`Move failed: ${await res.text()}`);
}

async function readFileContent(token: string, fileId: string) {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Cannot read ${fileId}`);
  }
  return res.text();
}

async function findRegistryInfo(token: string, centerFolderId: string, targetName: string) {
  const centerFiles = await listFilesInFolder(token, centerFolderId);
  const registryFile = centerFiles.find((f: any) => f.mimeType === DRIVE_SHEET_MIME && canonicalText(f.name).includes("index"));
  if (!registryFile) return null;

  const exportRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const csvText = await exportRes.text();
  const workbook = XLSX.read(csvText, { type: "string" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][];

  const headerIdx = rawRows.findIndex((row: any, idx: number) => {
    if (idx > 10) return false;
    const norm = row.map((c: any) => canonicalText(String(c)));
    return norm.some((c: string) => ["id", "cislo"].some(v => c.includes(v)))
      && norm.some((c: string) => ["jmeno", "nazev", "cast"].some(v => c.includes(v)));
  });
  if (headerIdx < 0) return null;

  const header = rawRows[headerIdx].map((c: any) => canonicalText(String(c)));
  const statusCol = header.findIndex((h: string) => ["stav", "status"].some(hint => h.includes(hint)));
  const nameCol = header.findIndex((h: string) => ["jmeno", "nazev", "cast"].some(hint => h.includes(hint)));

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const rowName = canonicalText(String(rawRows[i][nameCol] ?? ""));
    if (rowName.includes(targetName)) {
      return {
        registryFileId: registryFile.id,
        sheetName,
        statusCol,
        rowIndex: i,
        currentStatus: String(rawRows[i][statusCol] ?? ""),
      };
    }
  }
  return null;
}

async function updateRegistryCell(token: string, fileId: string, sheetName: string, col: number, row: number, value: string) {
  const colLetter = String.fromCharCode(65 + col);
  const cellRange = `${sheetName}!${colLetter}${row + 1}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ range: cellRange, majorDimension: "ROWS", values: [[value]] }) }
  );
  return { ok: res.ok, cellRange };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const token = await getAccessToken();
    const log: string[] = [];
    let body: any = {};
    try { body = await req.json(); } catch {}
    const step = body.step || "prepare";

    const kartotekaId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
    if (!kartotekaId) throw new Error("KARTOTEKA_DID not found");

    const rootChildren = await listFilesInFolder(token, kartotekaId);
    const activeFolder = rootChildren.find((f: any) => f.mimeType === DRIVE_FOLDER_MIME && /^01/.test(f.name.trim()));
    const archiveFolder = rootChildren.find((f: any) => f.mimeType === DRIVE_FOLDER_MIME && /^03/.test(f.name.trim()));
    const centerFolder = rootChildren.find((f: any) => f.mimeType === DRIVE_FOLDER_MIME && /^00/.test(f.name.trim()));
    if (!activeFolder || !archiveFolder) throw new Error("Folders not found");

    if (step === "prepare") {
      // Move Christoffer to archive
      const activeFiles = await listFilesInFolder(token, activeFolder.id);
      const cf = activeFiles.find((f: any) => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
      if (cf) {
        await moveFile(token, cf.id, archiveFolder.id, activeFolder.id);
        log.push(`✅ Moved "${cf.name}" → ARCHIV`);
      } else {
        log.push(`ℹ️ Already in archive`);
      }

      // Reset registry to "Spí"
      if (centerFolder) {
        const info = await findRegistryInfo(token, centerFolder.id, "christoffer");
        if (!info) { const info2 = await findRegistryInfo(token, centerFolder.id, "kristoffer"); }
        const regInfo = info || await findRegistryInfo(token, centerFolder.id, "kristoffer");
        if (regInfo) {
          const r = await updateRegistryCell(token, regInfo.registryFileId, regInfo.sheetName, regInfo.statusCol, regInfo.rowIndex, "Spí");
          log.push(r.ok ? `✅ Registry reset to "Spí" at ${r.cellRange}` : `❌ Registry reset failed`);
        } else {
          log.push(`❌ Christoffer not found in registry`);
        }
      }

      // Create fake thread
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: existing } = await sb.from("did_threads").select("id").eq("part_name", "Christoffer").eq("is_processed", false);
      if (existing?.length) {
        log.push(`ℹ️ Thread already exists: ${existing[0].id}`);
      } else {
        const { data: any } = await sb.from("did_threads").select("user_id").limit(1).single();
        const { error } = await sb.from("did_threads").insert({
          part_name: "Christoffer", sub_mode: "cast", part_language: "no", user_id: any?.user_id,
          messages: [
            { role: "user", content: "Hei... jeg er Christoffer. Jeg er her." },
            { role: "assistant", content: "Hei, Christoffer. Du er trygg." },
            { role: "user", content: "Jeg var borte lenge. Men nå er jeg her igjen." },
          ],
          is_processed: false,
        });
        log.push(error ? `❌ Thread: ${error.message}` : `✅ Thread created`);
      }
      log.push(`\n🔜 Now call daily cycle, then verify.`);

    } else if (step === "verify") {
      // Check card in active
      const activeFiles = await listFilesInFolder(token, activeFolder.id);
      const cf = activeFiles.find((f: any) => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
      if (cf) {
        log.push(`✅ Christoffer in AKTIVNI: ${cf.name}`);
        const card = await readFileContent(token, cf.id);
        log.push(`\n📋 VERIFICATION:`);
        log.push(`   A: Status has "Aktivní": ${/Status:.*Aktivní/i.test(card)}`);
        log.push(`   A: Status NO "💤 Spí": ${!/Status:\s*💤/.test(card)}`);
        log.push(`   E: Has probuzení entry: ${card.includes("Probuzení")}`);
        log.push(`   E: No "💤 Spí" as current: ${!/Aktuální stav\s*\n?\s*💤/.test(card)}`);
        log.push(`   G: Has new row: ${card.includes("první kontakt po archivaci") || card.includes("Probuzení")}`);
        log.push(`   K: Has new row: ${card.includes("probuzení z archivu") || card.includes("Probíhá")}`);
        log.push(`   L: Has přesun: ${card.includes("03_ARCHIV") || card.includes("ARCHIV do 01_AKTIVNI")}`);
        
        // Show sections
        for (const s of ["A", "E", "G", "K", "L"]) {
          const re = new RegExp(`SEKCE ${s}[^═]*([\\s\\S]*?)(?=═══ SEKCE|$)`);
          const m = card.match(re);
          log.push(`\n--- SECTION ${s} (first 500 chars) ---\n${m ? m[1].trim().slice(0, 500) : "NOT FOUND"}`);
        }
      } else {
        log.push(`❌ Christoffer NOT in AKTIVNI!`);
      }

      // Check registry
      if (centerFolder) {
        let regInfo = await findRegistryInfo(token, centerFolder.id, "christoffer");
        if (!regInfo) regInfo = await findRegistryInfo(token, centerFolder.id, "kristoffer");
        if (regInfo) {
          log.push(`\n📊 REGISTRY: "${regInfo.currentStatus}" (expected "Aktivní", match: ${regInfo.currentStatus === "Aktivní"})`);
        }
      }
    }

    return new Response(JSON.stringify({ success: true, step, log }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
