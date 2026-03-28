import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { alert_id, part_name, alert_type, severity, message_preview, recommended_action } = body;

    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const TARGET_EMAIL = Deno.env.get("KATA_EMAIL");

    if (!RESEND_KEY || !TARGET_EMAIL) {
      console.warn("[safety-alert] Missing RESEND_KEY or TARGET_EMAIL");
      return new Response(JSON.stringify({ error: "missing_config" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const severityEmoji: Record<string, string> = {
      critical: "🚨🚨🚨",
      high: "⚠️⚠️",
      medium: "⚠️",
      low: "ℹ️",
    };

    const alertTypeLabels: Record<string, string> = {
      suicidal_ideation: "Suicidální myšlenky",
      self_harm: "Sebepoškozování",
      dissociative_crisis: "Disociativní krize",
      severe_distress: "Těžká úzkost/distress",
      aggressive_outburst: "Agresivní výbuch",
      reality_loss: "Ztráta reality",
      substance_mention: "Zmínka o substancích",
      abuse_disclosure: "Odhalení násilí",
      runaway_intent: "Úmysl utéct",
      other_risk: "Jiné riziko",
    };

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:${severity === "critical" ? "#dc2626" : "#f59e0b"};color:white;padding:16px;border-radius:8px 8px 0 0;text-align:center">
    <h1 style="margin:0;font-size:20px">${severityEmoji[severity] || "⚠️"} BEZPEČNOSTNÍ ALERT — ${(severity || "").toUpperCase()}</h1>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px;font-weight:bold;width:140px">Typ</td><td style="padding:8px">${alertTypeLabels[alert_type] || alert_type}</td></tr>
      <tr><td style="padding:8px;font-weight:bold">Část systému</td><td style="padding:8px">${part_name || "neznámá"}</td></tr>
      <tr><td style="padding:8px;font-weight:bold">Zpráva</td><td style="padding:8px;font-style:italic">${(message_preview || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td></tr>
      <tr><td style="padding:8px;font-weight:bold">Doporučená akce</td><td style="padding:8px;color:#dc2626;font-weight:bold">${recommended_action || ""}</td></tr>
    </table>
    <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb">
    <p style="font-size:12px;color:#6b7280">Alert ID: ${alert_id || "?"}<br>Čas: ${new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}<br>Tento alert byl vygenerován automaticky systémem Karel.</p>
  </div>
</div>`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Karel Alert <alert@resend.dev>",
        to: [TARGET_EMAIL],
        subject: `${severityEmoji[severity] || "⚠️"} Karel: ${alertTypeLabels[alert_type] || alert_type} — ${part_name || "?"}`,
        html,
      }),
    });

    const emailData = await emailRes.json();
    
    if (emailData.error) {
      throw new Error(`Resend error: ${JSON.stringify(emailData.error)}`);
    }
    
    console.log(`[safety-alert] Email sent: ${emailRes.status}`, emailData);

    return new Response(JSON.stringify({ success: true, email: emailData }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[safety-alert] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
