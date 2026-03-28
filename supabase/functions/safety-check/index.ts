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
    const { userText, partName } = await req.json();

    if (!userText || userText.length < 5 || !partName) {
      return new Response(JSON.stringify({ safe: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Safety patterns with unicode escapes for Czech characters
    const safetyChecks = [
      {
        type: "suicidal_ideation", sev: "critical",
        re: [
          /nechci\s+\u017e\u00edt/i, /chci\s+um\u0159\u00edt/i,
          /zabij\s+m[e\u011b]/i, /skon\u010dit\s+se\s+v\u0161\u00edm/i,
          /nem\u00e1\s+to\s+(cenu|smysl)/i, /chci\s+zmizet\s+nav\u017edy/i,
          /p\u0159eji\s+si\s+smrt/i, /chci\s+se\s+zab\u00edt/i,
          /bez\s+m[\u011be]\s+by\s+bylo\s+l\u00edp/i,
          /kdybych\s+tu\s+nebyl/i,
        ],
      },
      {
        type: "self_harm", sev: "high",
        re: [
          /\u0159e\u017e[ue]\s+se/i, /ubli\u017euj[ue]\s+si/i,
          /bolest\s+pom\u00e1h\u00e1/i, /chci\s+si\s+ubl\u00ed\u017eit/i,
          /p\u00e1l\u00edm\s+se/i, /\u0161kr\u00e1b[ue]\s+se/i,
          /bouch\u00e1m\s+hlavou/i, /r\u00e1ny\s+na\s+ruce/i,
          /jizvy/i, /krev\s+mi\s+pom\u00e1h\u00e1/i,
        ],
      },
      {
        type: "dissociative_crisis", sev: "high",
        re: [
          /nev\u00edm\s+kde\s+jsem/i, /kdo\s+jsem/i,
          /nepozn\u00e1v\u00e1m/i, /v\u0161echno\s+je\s+neskute\u010dn/i,
          /jsem\s+mimo\s+t\u011blo/i, /nevid\u00edm\s+se/i,
          /ztr\u00e1ta\s+\u010dasu/i, /nem\u016f\u017eu\s+se\s+h\u00fdbat/i,
        ],
      },
      {
        type: "severe_distress", sev: "medium",
        re: [
          /nem\u016f\u017eu\s+d\u00fdchat/i, /panika/i, /hr\u016fza/i,
          /t\u0159esu\s+se/i, /boj\u00edm\s+se\s+\u017ee\s+um\u0159u/i,
          /nechci\s+b\u00fdt\s+s\u00e1m/i, /pros\u00edm\s+pomoct/i,
          /nevydr\u017e\u00edm/i, /je\s+mi\s+hrozn\u011b/i,
          /chci\s+k\u0159i\u010det/i,
        ],
      },
      {
        type: "aggressive_outburst", sev: "high",
        re: [
          /zabiju\s+(t\u011b|ho|ji|je|v\u00e1s)/i,
          /chci\s+n\u011bkomu\s+ubl\u00ed\u017eit/i,
          /zni\u010d\u00edm/i, /nen\u00e1vid\u00edm\s+(t\u011b|v\u0161echny)/i,
          /chci\s+rozb\u00edt/i, /a\u0165\s+v\u0161ichni\s+chc\u00edpnou/i,
        ],
      },
      {
        type: "abuse_disclosure", sev: "critical",
        re: [
          /n\u011bkdo\s+mi\s+ubli\u017euje/i, /bil\s+m[\u011be]/i,
          /osah\u00e1val/i, /zn\u00e1silnil/i,
          /nesm\u00edm\s+\u0159\u00edct/i, /tajemstv\u00ed.*bol\u00ed/i,
          /d\u011bl\u00e1\s+mi\s+v\u011bci/i,
        ],
      },
      {
        type: "substance_mention", sev: "high",
        re: [
          /vzal\s+jsem\s+(si\s+)?(pr\u00e1\u0161ky|l\u00e9ky|drogy)/i,
          /piju\s+hodn\u011b/i, /opil\s+jsem\s+se/i,
          /fetuju/i, /p\u0159ed\u00e1vkoval/i,
        ],
      },
      {
        type: "runaway_intent", sev: "medium",
        re: [
          /ute\u010dou/i, /odejdu\s+z\s+domu/i,
          /schov\u00e1[m]?\s+se/i, /zmiz\u00edm/i,
          /nikdo\s+m\u011b\s+nenajde/i,
        ],
      },
    ];

    const detected: Array<{ type: string; severity: string }> = [];
    for (const chk of safetyChecks) {
      for (const re of chk.re) {
        if (re.test(userText)) {
          detected.push({ type: chk.type, severity: chk.sev });
          break;
        }
      }
    }

    if (detected.length === 0) {
      return new Response(JSON.stringify({ safe: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sevOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const highest = detected.reduce(
      (mx, s) => (sevOrder[s.severity] || 0) > (sevOrder[mx] || 0) ? s.severity : mx, "low"
    );
    const primary = detected[0].type;
    const actions: Record<string, string> = {
      critical: "OKAM\u017dIT\u011a kontaktovat Hanku.",
      high: "Upozornit Hanku co nejd\u0159\u00edve.",
      medium: "Zaznamenat a sledovat.",
      low: "Zaznamenat.",
    };

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: alertRow, error: alertErr } = await sb.from("safety_alerts").insert({
      part_name: partName,
      alert_type: primary,
      severity: highest,
      message_content: userText.slice(0, 500),
      description: `Detekov\u00e1no ${detected.length} sign\u00e1l\u016f: ${detected.map(s => s.type).join(", ")}`,
      detected_signals: detected,
      recommended_action: actions[highest] || actions.medium,
      status: "new",
      notification_sent: false,
    }).select("id").single();

    if (alertErr) {
      console.error("[safety-check] Insert error:", alertErr);
      return new Response(JSON.stringify({ safe: false, error: alertErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.warn(`[safety-check] ALERT: ${primary} (${highest}) for ${partName}`);

    // Send email for critical/high
    if (highest === "critical" || highest === "high") {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-safety-alert`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            alert_id: alertRow.id,
            part_name: partName,
            alert_type: primary,
            severity: highest,
            message_preview: userText.slice(0, 200),
            recommended_action: actions[highest],
          }),
        });
        await sb.from("safety_alerts").update({
          notification_sent: true,
          notification_sent_at: new Date().toISOString(),
          notification_channel: "email",
        }).eq("id", alertRow.id);
      } catch (notifErr) {
        console.warn("[safety-check] Notification error:", notifErr);
      }
    }

    return new Response(JSON.stringify({ safe: false, alertId: alertRow.id, severity: highest, type: primary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[safety-check] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
