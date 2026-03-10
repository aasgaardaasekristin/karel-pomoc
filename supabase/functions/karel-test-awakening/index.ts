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
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";

const canonicalText = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function moveFile(token: string, fileId: string, newParentId: string, oldParentId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${oldParentId}&supportsAllDrives=true`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(`Move failed: ${await res.text()}`);
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return await exportRes.text();
  }
  return await res.text();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = await getAccessToken();
    const log: string[] = [];

    // Find KARTOTEKA_DID root
    const kartotekaId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");
    if (!kartotekaId) throw new Error("KARTOTEKA_DID folder not found");
    log.push(`✅ Kartoteka root: ${kartotekaId}`);

    // Find 01_AKTIVNI and 03_ARCHIV
    const rootChildren = await listFilesInFolder(token, kartotekaId);
    const activeFolder = rootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && /^01/.test(f.name.trim()));
    const archiveFolder = rootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && /^03/.test(f.name.trim()));
    const centerFolder = rootChildren.find(f => f.mimeType === DRIVE_FOLDER_MIME && /^00/.test(f.name.trim()));
    if (!activeFolder || !archiveFolder) throw new Error("Active or Archive folder not found");
    log.push(`✅ Active: ${activeFolder.name} (${activeFolder.id})`);
    log.push(`✅ Archive: ${archiveFolder.name} (${archiveFolder.id})`);

    // STEP 1: Find Christoffer in active folder and move back to archive
    const activeFiles = await listFilesInFolder(token, activeFolder.id);
    const christofferFile = activeFiles.find(f => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
    
    if (!christofferFile) {
      // Maybe already in archive?
      const archiveFiles = await listFilesInFolder(token, archiveFolder.id);
      const inArchive = archiveFiles.find(f => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
      if (inArchive) {
        log.push(`ℹ️ Christoffer already in archive: ${inArchive.name}`);
      } else {
        throw new Error("Christoffer not found in active or archive!");
      }
    } else {
      await moveFile(token, christofferFile.id, archiveFolder.id, activeFolder.id);
      log.push(`✅ STEP 1: Moved "${christofferFile.name}" from AKTIVNI → ARCHIV`);
    }

    // STEP 2: Reset registry status to "Spí"
    if (centerFolder) {
      const centerFiles = await listFilesInFolder(token, centerFolder.id);
      const registryFile = centerFiles.find(f => f.mimeType === DRIVE_SHEET_MIME && canonicalText(f.name).includes("index"));
      
      if (registryFile) {
        // Read CSV to find Christoffer's row
        const exportRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const csvText = await exportRes.text();
        const workbook = XLSX.read(csvText, { type: "string" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][];

        // Find header
        const headerIdx = rawRows.findIndex((row, idx) => {
          if (idx > 10) return false;
          const norm = row.map((c: any) => canonicalText(String(c)));
          return norm.some(c => ["id", "cislo"].some(v => c.includes(v)))
            && norm.some(c => ["jmeno", "nazev", "cast"].some(v => c.includes(v)));
        });

        if (headerIdx >= 0) {
          const header = rawRows[headerIdx].map((c: any) => canonicalText(String(c)));
          const statusCol = header.findIndex(h => ["stav", "status"].some(hint => h.includes(hint)));
          const nameCol = header.findIndex(h => ["jmeno", "nazev", "cast"].some(hint => h.includes(hint)));

          let targetRow = -1;
          for (let i = headerIdx + 1; i < rawRows.length; i++) {
            const rowName = canonicalText(String(rawRows[i][nameCol] ?? ""));
            if (rowName.includes("christoffer") || rowName.includes("kristoffer")) {
              targetRow = i;
              break;
            }
          }

          if (targetRow >= 0 && statusCol >= 0) {
            const colLetter = String.fromCharCode(65 + statusCol);
            const cellRange = `${sheetName}!${colLetter}${targetRow + 1}`;
            
            const updateRes = await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${registryFile.id}/values/${encodeURIComponent(cellRange)}?valueInputOption=USER_ENTERED`,
              {
                method: "PUT",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ range: cellRange, majorDimension: "ROWS", values: [["Spí"]] }),
              }
            );
            if (updateRes.ok) {
              log.push(`✅ STEP 2: Registry status reset to "Spí" at ${cellRange}`);
            } else {
              log.push(`❌ STEP 2: Registry update failed: ${await updateRes.text()}`);
            }
          } else {
            log.push(`❌ STEP 2: Could not find Christoffer row (${targetRow}) or status col (${statusCol})`);
          }
        }
      }
    }

    // STEP 3: Create a fake unprocessed thread for Christoffer to trigger awakening
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // First check if there's already an unprocessed thread
    const { data: existingThreads } = await sb.from("did_threads")
      .select("id")
      .eq("part_name", "Christoffer")
      .eq("is_processed", false);

    if (existingThreads && existingThreads.length > 0) {
      log.push(`ℹ️ STEP 3: Unprocessed Christoffer thread already exists (${existingThreads[0].id})`);
    } else {
      // Get any user_id from existing threads
      const { data: anyThread } = await sb.from("did_threads").select("user_id").limit(1).single();
      const userId = anyThread?.user_id;
      if (!userId) throw new Error("No user_id found");

      const { data: newThread, error: threadErr } = await sb.from("did_threads").insert({
        part_name: "Christoffer",
        sub_mode: "cast",
        part_language: "no",
        user_id: userId,
        messages: [
          { role: "user", content: "Hei... jeg er Christoffer. Jeg er her." },
          { role: "assistant", content: "Hei, Christoffer. Du er trygg. Jeg er her. Ingen skal skade deg. Kan du fortelle meg hvordan du har det?" },
          { role: "user", content: "Jeg vet ikke... jeg var borte lenge. Men nå er jeg her igjen. Er bestemor her?" },
        ],
        is_processed: false,
      }).select().single();

      if (threadErr) throw new Error(`Thread insert failed: ${threadErr.message}`);
      log.push(`✅ STEP 3: Created test thread ${newThread.id} for Christoffer`);
    }

    // STEP 4: Read card content BEFORE triggering daily cycle (for comparison)
    const archiveFilesBefore = await listFilesInFolder(token, archiveFolder.id);
    const christofferInArchive = archiveFilesBefore.find(f => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
    let cardBefore = "";
    if (christofferInArchive) {
      cardBefore = await readFileContent(token, christofferInArchive.id);
      // Check key sections
      const hasSpíInA = cardBefore.includes("💤 Spí");
      const hasSpíInE = cardBefore.includes("💤 Spí");
      log.push(`✅ STEP 4: Card BEFORE – has "💤 Spí" in content: ${hasSpíInA}`);
      log.push(`   Card file: ${christofferInArchive.name} (${christofferInArchive.id}), ${cardBefore.length} chars`);
    }

    // STEP 5: Trigger the daily cycle with source=test_manual
    log.push(`🔄 STEP 5: Triggering daily cycle...`);
    const cycleRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-daily-cycle`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "test_manual" }),
    });
    const cycleResult = await cycleRes.json();
    log.push(`✅ STEP 5: Daily cycle result: ${JSON.stringify(cycleResult).slice(0, 500)}`);

    // STEP 6: Verify results
    // 6a: Check if Christoffer is now in active folder
    const activeFilesAfter = await listFilesInFolder(token, activeFolder.id);
    const christofferInActive = activeFilesAfter.find(f => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
    
    if (christofferInActive) {
      log.push(`✅ STEP 6a: Christoffer FOUND in AKTIVNI: ${christofferInActive.name}`);
      
      // 6b: Read card content AFTER
      const cardAfter = await readFileContent(token, christofferInActive.id);
      
      // Check sections
      const hasAktivniInA = cardAfter.includes("Aktivní") && !cardAfter.match(/Status:\s*💤/);
      const hasAktivniInE = !cardAfter.match(/Aktuální stav\s*\n?\s*💤/);
      const hasGEntry = cardAfter.includes("Probuzení") && cardAfter.includes("první kontakt");
      const hasKEntry = cardAfter.includes("probuzení z archivu") || cardAfter.includes("probuzení");
      const hasLEntry = cardAfter.includes("Přesunuto z 03_ARCHIV");
      
      log.push(`✅ STEP 6b: Card content verification:`);
      log.push(`   Section A - Status changed from Spí to Aktivní: ${hasAktivniInA}`);
      log.push(`   Section E - Aktuální stav no longer Spí: ${hasAktivniInE}`);
      log.push(`   Section G - Has probuzení entry: ${hasGEntry}`);
      log.push(`   Section K - Has probuzení entry: ${hasKEntry}`);
      log.push(`   Section L - Has přesun entry: ${hasLEntry}`);
      
      // Show relevant snippets
      const sectionEMatch = cardAfter.match(/SEKCE E[^═]*([\s\S]*?)(?=═══ SEKCE F|$)/);
      if (sectionEMatch) {
        log.push(`\n📄 SECTION E content (first 500 chars):\n${sectionEMatch[1].trim().slice(0, 500)}`);
      }
      const sectionGMatch = cardAfter.match(/SEKCE G[^═]*([\s\S]*?)(?=═══ SEKCE H|$)/);
      if (sectionGMatch) {
        log.push(`\n📄 SECTION G content (first 300 chars):\n${sectionGMatch[1].trim().slice(0, 300)}`);
      }
      const sectionLMatch = cardAfter.match(/SEKCE L[^═]*([\s\S]*?)(?=═══ SEKCE M|$)/);
      if (sectionLMatch) {
        log.push(`\n📄 SECTION L content (first 300 chars):\n${sectionLMatch[1].trim().slice(0, 300)}`);
      }
    } else {
      log.push(`❌ STEP 6a: Christoffer NOT found in AKTIVNI after daily cycle!`);
      // Check if still in archive
      const archiveFilesAfter = await listFilesInFolder(token, archiveFolder.id);
      const stillInArchive = archiveFilesAfter.find(f => canonicalText(f.name).includes("christoffer") || /009/.test(f.name));
      if (stillInArchive) {
        log.push(`   ⚠️ Still in archive: ${stillInArchive.name}`);
      }
    }

    // 6c: Check registry status
    if (centerFolder) {
      const centerFiles = await listFilesInFolder(token, centerFolder.id);
      const registryFile = centerFiles.find(f => f.mimeType === DRIVE_SHEET_MIME && canonicalText(f.name).includes("index"));
      if (registryFile) {
        const exportRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${registryFile.id}/export?mimeType=text/csv&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const csvText = await exportRes.text();
        const workbook = XLSX.read(csvText, { type: "string" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as any[][];

        const headerIdx = rawRows.findIndex((row, idx) => {
          if (idx > 10) return false;
          const norm = row.map((c: any) => canonicalText(String(c)));
          return norm.some(c => ["id", "cislo"].some(v => c.includes(v)))
            && norm.some(c => ["jmeno", "nazev", "cast"].some(v => c.includes(v)));
        });
        if (headerIdx >= 0) {
          const header = rawRows[headerIdx].map((c: any) => canonicalText(String(c)));
          const statusCol = header.findIndex(h => ["stav", "status"].some(hint => h.includes(hint)));
          const nameCol = header.findIndex(h => ["jmeno", "nazev", "cast"].some(hint => h.includes(hint)));
          for (let i = headerIdx + 1; i < rawRows.length; i++) {
            const rowName = canonicalText(String(rawRows[i][nameCol] ?? ""));
            if (rowName.includes("christoffer") || rowName.includes("kristoffer")) {
              const currentStatus = String(rawRows[i][statusCol] ?? "");
              log.push(`\n✅ STEP 6c: Registry status for Christoffer: "${currentStatus}"`);
              log.push(`   Expected: "Aktivní" — Match: ${currentStatus === "Aktivní"}`);
              break;
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, log }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
