import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, listFiles, resolveKartotekaRoot,
  FOLDER_MIME,
} from "../_shared/driveHelpers.ts";

/**
 * run-daily-card-updates: Orchestrator
 * Loops through active parts, finds unprocessed threads, calls update-part-card for each.
 */

const TIMEOUT_MS = 280_000; // 280s safety margin (function limit 300s)

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__";
  if (authHeader !== `Bearer ${srvKey}`) {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
  }

  const startTime = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);
  const results: any[] = [];
  let partsProcessed = 0;
  let partsSkipped = 0;

  try {
    const body = await req.json().catch(() => ({}));
    const singlePart = (body as any).partName || null;

    const token = await getAccessToken();
    const rootId = await resolveKartotekaRoot(token);
    if (!rootId) {
      return new Response(JSON.stringify({ error: "kartoteka_DID not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find 01_AKTIVNI_FRAGMENTY
    const rootFiles = await listFiles(token, rootId);
    const aktivniFolder = rootFiles.find(f =>
      f.mimeType === FOLDER_MIME && (/^01/.test(f.name) || f.name.toLowerCase().includes("aktiv"))
    );
    if (!aktivniFolder) {
      return new Response(JSON.stringify({ error: "01_AKTIVNI_FRAGMENTY not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // List part folders
    let partFolders = (await listFiles(token, aktivniFolder.id))
      .filter(f => f.mimeType === FOLDER_MIME)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (singlePart) {
      partFolders = partFolders.filter(f => f.name.includes(singlePart));
    }

    console.log(`[daily-cards] Found ${partFolders.length} part folders to process`);

    for (const folder of partFolders) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        console.warn(`[daily-cards] Timeout approaching, stopping. Processed ${partsProcessed}/${partFolders.length}`);
        break;
      }

      const partName = folder.name;
      console.log(`[daily-cards] Processing: ${partName}`);

      try {
        // Find unprocessed threads for this part from did_conversations
        // Extract part identifier from folder name (e.g. "003_TUNDRUPEK" → "Tundrupek")
        const partLabel = partName.replace(/^\d+_/, "").toLowerCase();

        const { data: recentThreads } = await sb.from("did_conversations")
          .select("id, messages, label, updated_at")
          .eq("sub_mode", "cast")
          .gte("updated_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .order("updated_at", { ascending: false })
          .limit(50);

        // Filter threads matching this part (by label)
        const partThreads = (recentThreads || []).filter(t => {
          const label = (t.label || "").toLowerCase();
          return label.includes(partLabel) || partLabel.includes(label.replace(/[^a-z]/g, ""));
        });

        if (partThreads.length === 0) {
          console.log(`[daily-cards] No recent threads for ${partName}, skipping`);
          partsSkipped++;
          continue;
        }

        // Check which are already processed
        const threadIds = partThreads.map(t => t.id);
        const { data: processed } = await sb.from("card_update_processed_threads")
          .select("thread_id")
          .eq("part_name", partName)
          .in("thread_id", threadIds);

        const processedSet = new Set((processed || []).map(p => p.thread_id));
        const unprocessed = partThreads.filter(t => !processedSet.has(t.id));

        if (unprocessed.length === 0) {
          console.log(`[daily-cards] All threads already processed for ${partName}`);
          partsSkipped++;
          continue;
        }

        console.log(`[daily-cards] ${unprocessed.length} unprocessed threads for ${partName}`);

        // Call update-part-card
        const updateUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/update-part-card`;
        const threadContents = unprocessed.map(t => ({
          threadId: t.id,
          messages: Array.isArray(t.messages) ? t.messages : [],
        }));

        const updateRes = await fetch(updateUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srvKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            partName,
            folderId: folder.id,
            threadContents,
            forceFullUpdate: false,
          }),
        });

        const updateData = await updateRes.json();
        results.push({ partName, ...updateData });
        partsProcessed++;

        console.log(`[daily-cards] ✅ ${partName}: ${updateRes.status} ${updateData.success ? "OK" : "FAIL"}`);
      } catch (partErr) {
        console.error(`[daily-cards] Error processing ${partName}:`, partErr);
        results.push({ partName, error: String(partErr) });
      }
    }

    // Process pending crosswrite queue items
    try {
      const { data: pending } = await sb.from("card_crosswrite_queue")
        .select("*")
        .eq("status", "pending")
        .order("created_at")
        .limit(20);

      if (pending && pending.length > 0) {
        console.log(`[daily-cards] Processing ${pending.length} pending crosswrites`);
        // Crosswrites are processed inline by update-part-card for known targets
        // Mark remaining as deferred
        for (const item of pending) {
          await sb.from("card_crosswrite_queue")
            .update({ status: "deferred", processed_at: new Date().toISOString() })
            .eq("id", item.id);
        }
      }
    } catch (cwErr) {
      console.warn("[daily-cards] Crosswrite queue processing error:", cwErr);
    }

    const totalTime = Date.now() - startTime;
    console.log(`[daily-cards] Done: ${partsProcessed} processed, ${partsSkipped} skipped, ${totalTime}ms`);

    return new Response(JSON.stringify({
      success: true,
      partsProcessed,
      partsSkipped,
      totalParts: partFolders.length,
      processingTimeMs: totalTime,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[daily-cards] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
