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
    //
    // HARDENING (Slice 3 stabilizace): bridge MUSÍ vycházet ze schváleného
    // obsahu deliberation, ne z hardcoded "hanka/individual". Autoritativní
    // zdroj parametrů je `session_params` jsonb sloupec naplněný při create
    // přímo z briefing prefillu (led_by, session_format, duration_min, …).
    // Fallback řetězec použijeme jen když deliberation z nějakého důvodu
    // session_params nemá (legacy záznamy před touto migrací).
    let bridgedPlanId: string | null = updated.linked_live_session_id ?? null;
    if (
      updated.status === "approved" &&
      updated.deliberation_type === "session_plan" &&
      !updated.linked_live_session_id
    ) {
      const today = new Date().toISOString().slice(0, 10);

      const sp = (updated.session_params && typeof updated.session_params === "object")
        ? updated.session_params as Record<string, any>
        : {};

      // Mapování led_by ("Hanička"|"Káťa"|"společně") → therapist (hanka|kata|joint).
      const ledByRaw = String(sp.led_by ?? "").trim();
      const ledByLower = ledByRaw.toLowerCase();
      let therapist: string;
      let sessionLead: string;
      if (ledByLower.startsWith("ha")) { therapist = "hanka"; sessionLead = "hanka"; }
      else if (ledByLower.startsWith("ká") || ledByLower.startsWith("ka")) { therapist = "kata"; sessionLead = "kata"; }
      else if (ledByLower.startsWith("sp")) { therapist = "joint"; sessionLead = "joint"; }
      else {
        // Žádný explicitní vůdce — neházíme hardcoded hanka, ale označíme unassigned,
        // aby UI vidělo, že to ještě nebylo schváleno.
        therapist = "unassigned";
        sessionLead = "unassigned";
      }

      const sessionFormat = (sp.session_format === "individual" || sp.session_format === "joint")
        ? sp.session_format
        : (therapist === "joint" ? "joint" : "individual");

      const part = String(sp.part_name ?? updated.subject_parts?.[0] ?? "").trim();

      // Agenda + otázky vypíšeme do plan_markdown, ať je z denního plánu vidět
      // celý schválený obsah, ne jen stručný brief.
      const agendaLines: string[] = [];
      const agenda = Array.isArray(updated.agenda_outline) ? updated.agenda_outline : [];
      if (agenda.length > 0) {
        agendaLines.push("## Osnova");
        agenda.forEach((b: any, i: number) => {
          const min = typeof b?.minutes === "number" ? ` (${b.minutes} min)` : "";
          const detail = b?.detail ? ` — ${b.detail}` : "";
          agendaLines.push(`${i + 1}. **${b?.block ?? ""}**${min}${detail}`);
        });
        agendaLines.push("");
      }

      const qBlock = (label: string, list: any): string[] => {
        const arr = Array.isArray(list) ? list : [];
        if (arr.length === 0) return [];
        const out = [`## Otázky pro ${label}`];
        arr.forEach((q: any) => {
          const txt = typeof q === "string" ? q : (q?.question ?? "");
          if (txt) out.push(`- ${txt}`);
        });
        out.push("");
        return out;
      };

      const planRow: Record<string, any> = {
        user_id: userId,
        plan_date: today,
        selected_part: part || "(neurčeno)",
        therapist,
        session_format: sessionFormat,
        status: "planned",
        urgency_score: updated.priority === "crisis" ? 100 : 70,
        urgency_breakdown: {
          source: "team_deliberation",
          deliberation_id: deliberationId,
          led_by: ledByRaw || null,
          duration_min: typeof sp.duration_min === "number" ? sp.duration_min : null,
          kata_involvement: sp.kata_involvement ?? null,
        },
        plan_markdown: [
          `# Schválený plán z týmové porady`,
          `**Porada:** ${updated.title}`,
          ledByRaw ? `**Vede:** ${ledByRaw}` : "",
          typeof sp.duration_min === "number" ? `**Délka:** ~${sp.duration_min} min` : "",
          sp.why_today ? `**Proč dnes:** ${sp.why_today}` : "",
          sp.kata_involvement ? `**Káťa:** ${sp.kata_involvement}` : "",
          updated.reason ? `**Důvod:** ${updated.reason}` : "",
          ``,
          `## Karlův schválený návrh`,
          updated.karel_proposed_plan ?? "",
          ``,
          ...agendaLines,
          ...qBlock("Haničku", updated.questions_for_hanka),
          ...qBlock("Káťu", updated.questions_for_kata),
          updated.final_summary ? `## Závěr porady\n${updated.final_summary}` : "",
        ].filter(Boolean).join("\n"),
        generated_by: "team_deliberation",
        session_lead: sessionLead,
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
      } else if (planErr) {
        console.error("[delib-signoff] bridge insert failed:", planErr);
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
