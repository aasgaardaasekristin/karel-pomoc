import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Server-side kartoteka update orchestrator for CRON execution.
 *
 * Pipeline:
 *  1. Fetch unprocessed DID threads (sub_mode='cast', not in thread_processing_log)
 *  2. Group by part_name
 *  3. For each part: call karel-thread-analyzer → get section updates
 *  4. Send sections to karel-did-card-update (append-only, no memory issues)
 *  5. Insert audit records into thread_processing_log
 *  6. Archive check: cards > 150K chars trigger karel-kartoteka-archiver
 */

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

const FOLDER_MIME = "application/vnd.google-apps.folder";
const ARCHIVE_THRESHOLD_CHARS = 150000;

async function findKartotekaRoot(token: string): Promise<string | null> {
  for (const name of ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID"]) {
    const q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
      q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    })}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.files?.[0]?.id) return data.files[0].id;
  }
  return null;
}

async function listFiles(token: string, folderId: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function getDocEndIndex(token: string, fileId: string): Promise<number> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return 0;
  const data = await res.json();
  const content = data?.body?.content || [];
  if (content.length === 0) return 0;
  return Number(content[content.length - 1]?.endIndex || 0);
}

const THERAPIST_BLACKLIST = [
  "hanka", "hanička", "hanicka", "hana", "hani",
  "káťa", "kata", "kateřina", "katerina",
  "karel",
];

function isTherapistName(name: string): boolean {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return THERAPIST_BLACKLIST.some((t) => normalized === t || normalized.includes(t));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Accept CRON calls (service role) or authenticated user calls
  const authHeader = req.headers.get("Authorization") || "";
  const isServiceCall = authHeader === `Bearer ${serviceKey}`;
  if (!isServiceCall) {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { error } = await userClient.auth.getClaims(token);
    if (error) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const startTime = Date.now();
  const log: string[] = [];
  const addLog = (msg: string) => { log.push(msg); console.log(`[kartoteka-cron] ${msg}`); };

  try {
    // ── STEP 1+2: Fetch unprocessed threads (is_processed=false, no time cutoff) ──
    const { data: threads, error: fetchErr } = await supabase
      .from("did_threads")
      .select("id, part_name, messages, last_activity_at, thread_label")
      .eq("sub_mode", "cast")
      .eq("is_processed", false)
      .order("last_activity_at", { ascending: true })
      .limit(50);

    if (fetchErr) throw new Error(`Thread fetch error: ${fetchErr.message}`);
    if (!threads?.length) {
      addLog("No unprocessed threads found.");
      return new Response(JSON.stringify({ ok: true, log, threads: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Filter out therapists
    const safeThreads = threads.filter((t) => !isTherapistName(t.part_name));
    addLog(`Found ${safeThreads.length} threads (filtered from ${threads.length})`);

    // Filter already processed
    const threadIds = safeThreads.map((t) => t.id);
    const { data: processed } = await supabase
      .from("thread_processing_log")
      .select("thread_id")
      .in("thread_id", threadIds)
      .eq("status", "completed")
      .eq("processing_type", "kartoteka_update");

    const processedSet = new Set((processed ?? []).map((p) => p.thread_id));
    const unprocessed = safeThreads.filter((t) => !processedSet.has(t.id));
    addLog(`${unprocessed.length} threads to process`);

    if (unprocessed.length === 0) {
      return new Response(JSON.stringify({ ok: true, log, threads: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STEP 3: Group by part ──
    const partGroups = new Map<string, typeof unprocessed>();
    for (const t of unprocessed) {
      const group = partGroups.get(t.part_name) ?? [];
      group.push(t);
      partGroups.set(t.part_name, group);
    }
    addLog(`Grouped into ${partGroups.size} parts`);

    // ── STEP 4: Process each part ──
    let successCount = 0;
    let failCount = 0;

    for (const [partName, partThreads] of partGroups) {
      const partThreadIds = partThreads.map((t) => t.id);
      addLog(`Processing "${partName}" (${partThreads.length} threads)…`);

      try {
        // Mark as processing
        await supabase
          .from("thread_processing_log")
          .upsert(
            partThreadIds.map((id) => ({
              thread_id: id,
              part_id: partName,
              processing_type: "kartoteka_update",
              status: "processing",
            })),
            { onConflict: "thread_id,processing_type" }
          );

        // Call thread analyzer
        const { data: analysisData, error: analysisErr } = await supabase.functions.invoke(
          "karel-thread-analyzer",
          { body: { partId: partName, threads: partThreads, currentCard: {} } }
        );

        if (analysisErr) throw new Error(`Analyzer error: ${JSON.stringify(analysisErr)}`);

        // Thread analyzer returns array of {section, subsection, type, content, ...}
        const updates = analysisData?.updates || [];
        const sections: Record<string, string> = {};

        for (const u of updates) {
          if (u?.section && u?.content) {
            const key = u.section;
            sections[key] = sections[key]
              ? `${sections[key]}\n${u.content}`
              : u.content;
          }
        }

        const sectionCount = Object.keys(sections).length;
        if (sectionCount === 0) {
          addLog(`  No updates for "${partName}", skipping write.`);
        } else {
          // Call card-update (append-only, no memory issues)
          const { error: writeErr } = await supabase.functions.invoke(
            "karel-did-card-update",
            { body: { partName, sections } }
          );
          if (writeErr) throw new Error(`Card update error: ${JSON.stringify(writeErr)}`);
          addLog(`  ✅ Appended ${sectionCount} sections to "${partName}"`);
        }

        // Mark completed
        const now = new Date().toISOString();
        await supabase
          .from("thread_processing_log")
          .update({ status: "completed", processed_at: now })
          .in("thread_id", partThreadIds)
          .eq("processing_type", "kartoteka_update");

        await supabase
          .from("did_threads")
          .update({ is_processed: true, processed_at: now })
          .in("id", partThreadIds);

        successCount++;
      } catch (err) {
        addLog(`  ❌ Error for "${partName}": ${err}`);
        await supabase
          .from("thread_processing_log")
          .update({ status: "failed", notes: JSON.stringify({ error: String(err) }) })
          .in("thread_id", partThreadIds)
          .eq("processing_type", "kartoteka_update");
        failCount++;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    addLog(`Done in ${elapsed}s: ${successCount} ok, ${failCount} failed`);

    return new Response(JSON.stringify({
      ok: true, log, threads: unprocessed.length,
      parts: partGroups.size, success: successCount, failed: failCount,
      elapsed_seconds: Number(elapsed),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    addLog(`Fatal error: ${err}`);
    return new Response(JSON.stringify({ ok: false, error: String(err), log }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
