/**
 * karel-pantry-flush-to-drive
 *
 * Noční flush Spižírny (did_pantry_packages) na Drive.
 *
 * Tok ("přesýpací hodiny"):
 *   během dne   → balíky se kupí v `did_pantry_packages` se status='pending_drive'
 *   ~04:00 ráno → tato funkce vyflushne balíky do `did_pending_drive_writes`,
 *                 která je fyzickým writerem na Google Drive.
 *   ~05:00 ráno → karel-did-daily-cycle si z Drive natáhne base info pro nový den.
 *   ~06:00 ráno → dashboard připraven s aktualizovaným přehledem.
 *
 * Volá se jako cron (pg_cron + pg_net) — viz schedule v Lovable Cloud.
 * Manuální spuštění: POST {} jako service role nebo authenticated user.
 *
 * Idempotence: balík se přepne na status='flushed' až po úspěšném zařazení
 * do did_pending_drive_writes. Při chybě zůstane 'pending_drive' a příští
 * běh ho zkusí znovu (max 5 pokusů, pak status='failed').
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BATCH = 50;
const MAX_RETRIES = 5;

interface PantryPackage {
  id: string;
  user_id: string;
  package_type: string;
  source_id: string | null;
  source_table: string | null;
  content_md: string;
  drive_target_path: string;
  metadata: Record<string, any> | null;
  status: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // Vezmi balíky ke flushnutí — jen ty pending_drive starší než 60s,
    // aby nezachytil rozpracované writes z aktuální session.
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: pending, error: fetchErr } = await admin
      .from("did_pantry_packages")
      .select("*")
      .eq("status", "pending_drive")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);

    if (fetchErr) throw fetchErr;
    const list = (pending ?? []) as PantryPackage[];
    if (list.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        flushed: 0,
        message: "Žádné balíky k propsání.",
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let flushed = 0;
    let failed = 0;

    for (const pkg of list) {
      try {
        // Sestav obálku pro did_pending_drive_writes.
        const targetDoc = (pkg.drive_target_path || "").trim();
        const content = (pkg.content_md || "").trim();
        if (!targetDoc || !content) {
          throw new Error("Prázdný target nebo content");
        }

        // Anti-dup hint v content header (djb2 friendly).
        const headerLines = [
          `<!-- pantry_pkg=${pkg.id} type=${pkg.package_type} -->`,
          `<!-- generated_at=${new Date().toISOString()} -->`,
          "",
        ];
        const finalContent = `${headerLines.join("\n")}${content}`;

        const { error: enqueueErr } = await admin
          .from("did_pending_drive_writes")
          .insert({
            user_id: pkg.user_id,
            content: finalContent,
            target_document: targetDoc,
            write_type: "append",
            priority: "normal",
            status: "pending",
          });
        if (enqueueErr) throw enqueueErr;

        const { error: updErr } = await admin
          .from("did_pantry_packages")
          .update({ status: "flushed", flushed_at: new Date().toISOString(), flush_error: null })
          .eq("id", pkg.id);
        if (updErr) throw updErr;

        flushed++;
      } catch (e: any) {
        failed++;
        const retryCount = ((pkg.metadata as any)?.flush_retry_count ?? 0) + 1;
        const newStatus = retryCount >= MAX_RETRIES ? "failed" : "pending_drive";
        const newMeta = { ...(pkg.metadata ?? {}), flush_retry_count: retryCount };
        await admin
          .from("did_pantry_packages")
          .update({
            status: newStatus,
            flush_error: String(e?.message ?? e).slice(0, 500),
            metadata: newMeta,
          })
          .eq("id", pkg.id);
        console.error(`[pantry-flush] pkg ${pkg.id} failed (try ${retryCount}/${MAX_RETRIES}):`, e);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      flushed,
      failed,
      total_seen: list.length,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[pantry-flush] fatal:", e);
    return new Response(JSON.stringify({
      ok: false,
      error: e?.message ?? String(e),
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
