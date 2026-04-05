import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken,
  resolveKartotekaRoot,
  findFolder,
  listFiles,
  findCardFileInFolder,
  readFileContent,
  overwriteDoc,
  appendToDoc,
  moveFile,
  FOLDER_MIME,
  GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const SHEETS_MIME = "application/vnd.google-apps.spreadsheet";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { part_id, part_name, new_status, reason, triggered_by } = await req.json();

    if (!part_id || !part_name || !new_status || !reason) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["active", "sleeping"].includes(new_status)) {
      return new Response(JSON.stringify({ error: "new_status must be 'active' or 'sleeping'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const isActive = new_status === "active";
    const statusLabel = isActive ? "Aktivní" : "Spí";
    const results: string[] = [];

    // ── 1. Update did_part_registry ──
    const { error: regErr } = await sb
      .from("did_part_registry")
      .update({
        status: isActive ? "active" : "sleeping",
        updated_at: new Date().toISOString(),
      })
      .eq("id", part_id);

    if (regErr) {
      console.error("[part-status-sync] Registry update failed:", regErr);
      results.push(`⚠️ Registry update failed: ${regErr.message}`);
    } else {
      results.push(`✅ Registry updated: ${part_name} → ${statusLabel}`);
    }

    // ── 2. Update Google Sheet 01_Index_Vsech_Casti ──
    let token: string;
    try {
      token = await getAccessToken();
    } catch (e) {
      console.error("[part-status-sync] OAuth failed:", e);
      return new Response(JSON.stringify({ error: "Google OAuth failed", results }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const kartotekaRoot = await resolveKartotekaRoot(token);
    if (!kartotekaRoot) {
      results.push("⚠️ Kartoteka root not found on Drive");
    }

    let centrumId: string | null = null;
    if (kartotekaRoot) {
      centrumId = await findFolder(token, "00_CENTRUM", kartotekaRoot);
    }

    // Find and update Index sheet
    if (centrumId) {
      try {
        const centrumFiles = await listFiles(token, centrumId);
        const indexFile = centrumFiles.find(
          (f) => f.name.includes("01_Index") && f.mimeType === SHEETS_MIME
        );

        if (indexFile) {
          // Read sheet data
          const sheetRes = await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${indexFile.id}/values/A:Z`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const sheetData = await sheetRes.json();
          const rows = sheetData.values || [];

          // Find the row with this part_id (column A)
          let targetRow = -1;
          for (let i = 0; i < rows.length; i++) {
            const rowId = String(rows[i]?.[0] || "").trim();
            if (rowId === String(part_id).trim() || rowId === part_name) {
              targetRow = i + 1; // 1-indexed for Sheets API
              break;
            }
          }

          if (targetRow > 0) {
            // Determine status column (typically column C or D based on header)
            let statusCol = 2; // default C (0-indexed)
            let noteCol = 3; // default D
            const header = rows[0] || [];
            for (let c = 0; c < header.length; c++) {
              const h = String(header[c]).toLowerCase();
              if (h.includes("status") || h.includes("stav")) statusCol = c;
              if (h.includes("poznámka") || h.includes("note") || h.includes("pozn")) noteCol = c;
            }

            const statusCellRef = `${String.fromCharCode(65 + statusCol)}${targetRow}`;
            const noteCellRef = `${String.fromCharCode(65 + noteCol)}${targetRow}`;

            // Update status cell
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${indexFile.id}/values/${statusCellRef}?valueInputOption=RAW`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ values: [[statusLabel]] }),
              }
            );

            // Update note cell with date
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${indexFile.id}/values/${noteCellRef}?valueInputOption=RAW`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  values: [[`${dateStr}: ${statusLabel} (${reason.slice(0, 80)})`]],
                }),
              }
            );

            results.push(`✅ Index sheet updated: row ${targetRow}`);
          } else {
            results.push(`⚠️ Part ${part_name} not found in Index sheet`);
          }
        } else {
          results.push("⚠️ Index sheet file not found in 00_CENTRUM");
        }
      } catch (sheetErr) {
        console.error("[part-status-sync] Sheet update error:", sheetErr);
        results.push(`⚠️ Sheet update failed: ${sheetErr}`);
      }
    }

    // ── 3. Move card folder on Drive ──
    if (kartotekaRoot) {
      try {
        const srcFolderName = isActive ? "03_ARCHIV_SPICICH" : "01_AKTIVNI_FRAGMENTY";
        const dstFolderName = isActive ? "01_AKTIVNI_FRAGMENTY" : "03_ARCHIV_SPICICH";

        const srcParentId = await findFolder(token, srcFolderName, kartotekaRoot);
        const dstParentId = await findFolder(token, dstFolderName, kartotekaRoot);

        if (!srcParentId || !dstParentId) {
          results.push(`⚠️ Source or destination folder not found (${srcFolderName} / ${dstFolderName})`);
        } else {
          // Find part's subfolder in source
          const srcChildren = await listFiles(token, srcParentId);
          const partFolder = srcChildren.find(
            (f) =>
              f.mimeType === FOLDER_MIME &&
              (f.name.includes(part_name) || f.name.startsWith(`${part_id}_`))
          );

          if (partFolder) {
            await moveFile(token, partFolder.id, dstParentId, srcParentId);
            results.push(`✅ Card folder moved: ${srcFolderName} → ${dstFolderName}`);
          } else {
            // If moving to active and folder doesn't exist in archive, create in destination
            if (isActive) {
              const newFolderName = `${String(part_id).padStart(3, "0")}_${part_name}`;
              const createRes = await fetch(
                "https://www.googleapis.com/drive/v3/files",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    name: newFolderName,
                    parents: [dstParentId],
                    mimeType: FOLDER_MIME,
                  }),
                }
              );
              if (createRes.ok) {
                results.push(`✅ New folder created in ${dstFolderName}: ${newFolderName}`);
              } else {
                results.push(`⚠️ Failed to create folder: ${createRes.status}`);
              }
            } else {
              results.push(`⚠️ Part folder not found in ${srcFolderName}`);
            }
          }
        }
      } catch (moveErr) {
        console.error("[part-status-sync] Move error:", moveErr);
        results.push(`⚠️ Drive move failed: ${moveErr}`);
      }
    }

    // ── 4. Append to part card (sections A and L) ──
    if (kartotekaRoot) {
      try {
        const activeFolderId = await findFolder(
          token,
          isActive ? "01_AKTIVNI_FRAGMENTY" : "03_ARCHIV_SPICICH",
          kartotekaRoot
        );

        if (activeFolderId) {
          const partFolders = await listFiles(token, activeFolderId);
          const pf = partFolders.find(
            (f) =>
              f.mimeType === FOLDER_MIME &&
              (f.name.includes(part_name) || f.name.startsWith(`${part_id}_`))
          );

          if (pf) {
            const cardFile = await findCardFileInFolder(token, pf.id);
            if (cardFile) {
              const appendBlock = [
                "",
                `=== AKTUALIZACE ${dateStr} ===`,
                `Sekce A: Status změněn na ${statusLabel}. Důvod: ${reason}`,
                `Sekce L: Aktivita: ${dateStr} — ${new_status}. ${reason}`,
                "",
              ].join("\n");

              await appendToDoc(token, cardFile.id, appendBlock);
              results.push("✅ Card updated (sections A, L)");
            } else {
              results.push("⚠️ Card file not found in part folder");
            }
          }
        }
      } catch (cardErr) {
        console.error("[part-status-sync] Card append error:", cardErr);
        results.push(`⚠️ Card append failed: ${cardErr}`);
      }
    }

    // ── 5. Log to system_health_log ──
    await sb.from("system_health_log").insert({
      severity: "info",
      source: "part-status-sync",
      message: `${part_name} → ${new_status}`,
      metadata: { part_id, reason, triggered_by, results },
    });
    results.push("✅ system_health_log written");

    // ── 6. If autonomous, create pending question for confirmation ──
    if (triggered_by === "karel_autonomous") {
      await sb.from("did_pending_questions").insert({
        question: `Karel změnil status části ${part_name} na ${statusLabel}. Důvod: ${reason}. Potvrzujete tuto změnu?`,
        subject_type: "part_status_change",
        subject_id: part_id,
        directed_to: "both",
        blocking: null,
        status: "pending",
        expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      });
      results.push("✅ Pending question created for therapist confirmation");
    }

    console.log(`[part-status-sync] Done: ${part_name} → ${new_status}`, results);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[part-status-sync] Fatal error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
