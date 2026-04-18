/**
 * karel-team-deliberation-signoff
 *
 * Podepíše poradu jménem Karla, Haničky nebo Káti.
 * Po trojnásobném podpisu DB trigger automaticky překlopí status na `approved`.
 * Pokud je `deliberation_type = session_plan`, navíc propíše Karlův
 * schválený plán do `did_daily_session_plans` a nastaví `linked_live_session_id`.
 *
 * Vstup:
 *   { deliberation_id: string, signer: "hanka" | "kata" | "karel" }
 */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const deliberationId = String(body?.deliberation_id ?? "");
    const signer = String(body?.signer ?? "");
    if (!deliberationId || !["hanka", "kata", "karel"].includes(signer)) {
      return new Response(JSON.stringify({ error: "bad input" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Fetch row
    const { data: row, error: fetchErr } = await admin
      .from("did_team_deliberations")
      .select("*")
      .eq("id", deliberationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchErr || !row) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nowIso = new Date().toISOString();
    const patch: Record<string, any> = {};
    if (signer === "hanka" && !row.hanka_signed_at) patch.hanka_signed_at = nowIso;
    if (signer === "kata" && !row.kata_signed_at) patch.kata_signed_at = nowIso;
    if (signer === "karel" && !row.karel_signed_at) patch.karel_signed_at = nowIso;

    if (Object.keys(patch).length === 0) {
      return new Response(JSON.stringify({ deliberation: row, note: "already signed" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: updated, error: updErr } = await admin
      .from("did_team_deliberations")
      .update(patch)
      .eq("id", deliberationId)
      .select("*")
      .single();

    if (updErr) {
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // BRIDGE: if approved + session_plan → push do did_daily_session_plans
    let bridgedPlanId: string | null = updated.linked_live_session_id ?? null;
    if (
      updated.status === "approved" &&
      updated.deliberation_type === "session_plan" &&
      !updated.linked_live_session_id
    ) {
      const today = new Date().toISOString().slice(0, 10);
      const part = (updated.subject_parts?.[0] ?? "Tundrupek").toString();

      const planRow: Record<string, any> = {
        user_id: userId,
        plan_date: today,
        selected_part: part,
        therapist: "hanka",
        session_format: "individual",
        status: "planned",
        urgency_score: updated.priority === "crisis" ? 100 : 70,
        urgency_breakdown: { source: "team_deliberation" },
        plan_markdown: [
          `# Schválený plán z týmové porady\n`,
          `**Porada:** ${updated.title}`,
          updated.reason ? `**Důvod:** ${updated.reason}` : "",
          ``,
          `## Karlův schválený návrh`,
          updated.karel_proposed_plan ?? "",
          ``,
          updated.final_summary ? `## Závěr porady\n${updated.final_summary}` : "",
        ].filter(Boolean).join("\n"),
        generated_by: "team_deliberation",
        session_lead: "hanka",
      };

      const { data: planRes, error: planErr } = await admin
        .from("did_daily_session_plans")
        .insert(planRow)
        .select("id")
        .single();

      if (!planErr && planRes?.id) {
        bridgedPlanId = planRes.id;
        await admin
          .from("did_team_deliberations")
          .update({ linked_live_session_id: bridgedPlanId })
          .eq("id", deliberationId);
      }
    }

    return new Response(JSON.stringify({
      deliberation: { ...updated, linked_live_session_id: bridgedPlanId },
      bridged_plan_id: bridgedPlanId,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
