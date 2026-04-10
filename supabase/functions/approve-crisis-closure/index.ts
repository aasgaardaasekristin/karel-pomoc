import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const { crisisId, approver } = await req.json();
    if (!crisisId || !approver) {
      return new Response(JSON.stringify({ error: "crisisId and approver required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!["hanka", "kata"].includes(approver)) {
      return new Response(JSON.stringify({ error: "approver must be hanka or kata" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: crisis } = await sb.from("crisis_events").select("*").eq("id", crisisId).single();
    if (!crisis) return new Response(JSON.stringify({ error: "Crisis not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const approved = crisis.closure_approved_by || [];
    if (approved.includes(approver)) {
      return new Response(JSON.stringify({ error: "Already approved by this person" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const newApproved = [...approved, approver];

    // At least 1 therapist approval = close
    if (newApproved.length >= 1) {
      await sb.from("crisis_events").update({
        phase: "closed",
        closed_at: new Date().toISOString(),
        closure_approved_by: newApproved,
        closure_approved_at: new Date().toISOString(),
        closure_reason: `Schváleno: ${newApproved.join(", ")}. Diagnostické skóre: ${crisis.diagnostic_score || "N/A"}/100`,
        updated_at: new Date().toISOString(),
      }).eq("id", crisisId);

      // Downgrade urgency in planned_sessions
      await sb.from("planned_sessions")
        .update({ priority: "normal" })
        .eq("part_name", crisis.part_name)
        .eq("priority", "urgent");

      // Send closure email
      try {
        const { Resend } = await import("https://esm.sh/resend@2.0.0");
        const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
        const kataEmail = Deno.env.get("KATA_EMAIL") || "";
        if (kataEmail) {
          await resend.emails.send({
            from: "Karel <onboarding@resend.dev>",
            to: [kataEmail],
            subject: `✅ Krize uzavřena — ${crisis.part_name}`,
            html: `<h2>Krize uzavřena</h2>
<p><strong>Část:</strong> ${crisis.part_name}</p>
<p><strong>Trvání:</strong> ${crisis.days_active} dní, ${crisis.sessions_count} sezení</p>
<p><strong>Diagnostické skóre:</strong> ${crisis.diagnostic_score || "N/A"}/100</p>
<p>Část přechází do normálního režimu.</p>`,
          });
        }
      } catch (emailErr) {
        console.warn("[approve-closure] Email error:", emailErr);
      }

      return new Response(JSON.stringify({ success: true, closed: true, approvedBy: newApproved }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Not enough approvals yet
    await sb.from("crisis_events").update({
      closure_approved_by: newApproved,
      updated_at: new Date().toISOString(),
    }).eq("id", crisisId);

    return new Response(JSON.stringify({ success: true, closed: false, approvedBy: newApproved }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[approve-closure] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
