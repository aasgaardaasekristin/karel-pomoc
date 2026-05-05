/**
 * karel-create-05c-session-log-doc — NEUTRALIZED (P29A)
 *
 * P29A governance closeout: 05C_SEZENI_LOG is NOT a canonical Drive target.
 * This function previously created a Google Doc named "05C_SEZENI_LOG" inside
 * KARTOTEKA_DID/00_CENTRUM. Under the new governance hard gate that path is
 * not in CANONICAL_DRIVE_REGISTRY and any write is fail-closed.
 *
 * P29A reroute (variant B): session/daily clinical audit content must be
 * appended to the canonical 05A operational plan. This function therefore
 * no longer creates any Drive file; it only enqueues a governed append into
 * KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN through safeEnqueueDriveWrite.
 */

import { safeEnqueueDriveWrite } from "../_shared/documentGovernance.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REROUTE_TARGET = "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
const SECTION_HEADER = "## Sezení / denní audit klinických vstupů";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Hard governance answer: 05C_SEZENI_LOG cannot be created.
  // For backward compat with any callers, accept POST and reroute the marker
  // to 05A through the gated enqueue helper (no direct Drive create anymore).
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const today = new Date().toISOString().slice(0, 10);
    const marker =
      `\n\n${SECTION_HEADER}\n` +
      `_[${today}] P29A reroute: legacy 05C_SEZENI_LOG marker → 05A operativní plán._\n`;

    const enqRes = await safeEnqueueDriveWrite(
      admin as any,
      {
        target_document: REROUTE_TARGET,
        content: marker,
        write_type: "append",
        priority: "low",
        status: "pending",
      },
      { source: "karel-create-05c-session-log-doc(neutralized)" },
    );

    return json({
      ok: true,
      neutralized: true,
      original_target: "KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG",
      rerouted_to: REROUTE_TARGET,
      section: SECTION_HEADER,
      enqueued: enqRes.inserted,
      blocked_reason: enqRes.inserted ? null : (enqRes.reason ?? null),
      created: false,
      note:
        "P29A: 05C_SEZENI_LOG is not in CANONICAL_DRIVE_REGISTRY. " +
        "This function no longer creates a Drive file; clinical session/daily audit " +
        "content is appended to 05A_OPERATIVNI_PLAN via the governance-gated enqueue helper.",
    });
  } catch (e: any) {
    return json({ ok: false, neutralized: true, error: e?.message ?? String(e) }, 500);
  }
});
