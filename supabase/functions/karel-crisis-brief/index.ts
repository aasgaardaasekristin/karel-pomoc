import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { imprint } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase config missing");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Build signal list for prompt
    const signalList = [];
    if (imprint.signals.hopelessness) signalList.push("beznaděj");
    if (imprint.signals.regulationFailure) signalList.push("selhání regulace");
    if (imprint.signals.helpRefusal) signalList.push("odmítnutí krizové pomoci");
    if (imprint.signals.selfHarm) signalList.push("sebepoškozování");
    if (imprint.signals.domesticThreat) signalList.push("ohrožení v domácnosti");
    if (imprint.signals.narrowedFuture) signalList.push("zúžení budoucnosti");

    const systemPrompt = `Jsi supervizní asistent Karla – mentora terapeutky. Tvým úkolem je připravit stručný KRIZOVÝ SUPERVIZNÍ BRIEF.

DŮLEŽITÉ ETICKÉ ZÁSADY:
- NEZNÁŠ identitu klienta. Nemáš žádná osobní data.
- NEřešíš klienta. Připravuješ TERAPEUTKU na možný kontakt.
- Neprovádíš diagnózu. Shrnuješ signály a doporučuješ přípravu.

FORMÁT BRIEFU:
1. PŘEHLED RIZIK – stručné shrnutí situace a detekovaných signálů
2. DOPORUČENÝ ZPŮSOB KONTAKTU – telefon/SMS/email s důvody
3. NÁVRH PRVNÍCH VĚT – 3 konkrétní věty, kterými může terapeutka zahájit kontakt
4. RIZIKOVÉ FORMULACE – na co si dát pozor, jaké výroky mohou zaznít
5. DALŠÍ DOPORUČENÉ KROKY – co připravit, na co myslet

Piš česky, stručně, věcně. Max 300 slov celkem.`;

    const userContent = `KRIZOVÝ OTISK (anonymní, bez identity):
- Scénář: ${imprint.scenario}
- Risk score: ${imprint.riskScore}
- Klíčové signály: ${signalList.length > 0 ? signalList.join(", ") : "žádné specifické"}
- Regulační pokusy: ${imprint.regulationAttempts} (úspěšné: ${imprint.regulationSuccessful ? "ano" : "ne"})
- Časová dynamika: ${imprint.timeDynamics.messageCount} zpráv, vzorec eskalace: ${imprint.timeDynamics.riskEscalationPattern}
- Most k terapeutce: ${imprint.therapistBridgeTriggered ? `aktivován (metoda: ${imprint.therapistBridgeMethod})` : "neaktivován"}
- Poznámka: ${imprint.note}

Připrav supervizní brief pro terapeutku.`;

    // Generate brief via AI
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const briefText = data.choices?.[0]?.message?.content || "";
    const sections = parseBrief(briefText);

    // Store in database
    const { error: dbError } = await supabase.from("crisis_briefs").insert({
      scenario: imprint.scenario,
      risk_score: imprint.riskScore,
      signals: imprint.signals,
      regulation_attempts: imprint.regulationAttempts,
      regulation_successful: imprint.regulationSuccessful,
      therapist_bridge_triggered: imprint.therapistBridgeTriggered,
      therapist_bridge_method: imprint.therapistBridgeMethod,
      time_dynamics: imprint.timeDynamics,
      note: imprint.note,
      risk_overview: sections.riskOverview,
      recommended_contact: sections.recommendedContact,
      suggested_opening_lines: sections.suggestedOpeningLines,
      risk_formulations: sections.riskFormulations,
      next_steps: sections.nextSteps,
      raw_brief: briefText,
    });

    if (dbError) {
      console.error("DB insert error:", dbError);
    }

    // Send email notification if RESEND_API_KEY is configured
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    let notificationSent = false;
    const riskScore = imprint.riskScore as number;
    const isUrgent = riskScore >= 9;
    const isInfo = riskScore >= 7 && riskScore <= 8;

    if (RESEND_API_KEY && (isUrgent || isInfo)) {
      const emailSubject = isUrgent
        ? "⚠️ Krizový supervizní brief čeká v Karlovi"
        : "ℹ️ Supervizní upozornění (zvýšené riziko)";

      const emailHtml = isUrgent
        ? `<h2>⚠️ Krizový supervizní brief</h2>
<p><strong>Scénář:</strong> ${imprint.scenario}<br>
<strong>Risk score:</strong> ${riskScore}<br>
<strong>Čas:</strong> ${new Date().toLocaleString("cs-CZ")}</p>
<p>${sections.riskOverview ? sections.riskOverview.slice(0, 200) : "Byla detekována kritická úroveň rizika."}</p>
<p><strong>Otevři Karla a přečti doporučení.</strong></p>
<hr>
<p style="color:#666;font-size:12px;">Toto je supervizní upozornění systému, nikoli identita klienta. Žádná osobní data nebyla předána.</p>`
        : `<h2>ℹ️ Supervizní upozornění</h2>
<p><strong>Scénář:</strong> ${imprint.scenario}<br>
<strong>Risk score:</strong> ${riskScore}<br>
<strong>Čas:</strong> ${new Date().toLocaleString("cs-CZ")}</p>
<p>Bylo zaznamenáno zvýšené riziko v anonymní relaci. Situace je monitorována.</p>
<p>Otevři Karla a přečti doporučení.</p>
<hr>
<p style="color:#666;font-size:12px;">Toto je supervizní upozornění systému, nikoli identita klienta. Žádná osobní data nebyla předána.</p>`;

      try {
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: ["mujosobniasistentnamiru@gmail.com"],
            subject: emailSubject,
            html: emailHtml,
          }),
        });
        if (emailRes.ok) {
          notificationSent = true;
          console.log(`Email notification sent (${isUrgent ? "URGENT" : "INFO"})`);
        } else {
          console.error("Email error:", await emailRes.text());
        }
      } catch (e) {
        console.error("Email send failed:", e);
      }
    } else if (!RESEND_API_KEY) {
      console.log("RESEND_API_KEY not configured, skipping email notification");
    }

    // Send SMS notification if TWILIO credentials are configured
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER");

    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
      try {
        const smsRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: "+420773641106",
              From: TWILIO_PHONE_NUMBER,
              Body: `⚠️ Karel: Krizový brief čeká (risk ${imprint.riskScore}, scénář: ${imprint.scenario}). Otevři Karla.`,
            }).toString(),
          }
        );
        if (smsRes.ok) {
          notificationSent = true;
          console.log("SMS notification sent");
        } else {
          console.error("SMS error:", await smsRes.text());
        }
      } catch (e) {
        console.error("SMS send failed:", e);
      }
    } else {
      console.log("Twilio not configured, skipping SMS notification");
    }

    // Update notification_sent flag
    if (notificationSent && !dbError) {
      await supabase
        .from("crisis_briefs")
        .update({ notification_sent: true })
        .eq("scenario", imprint.scenario)
        .order("created_at", { ascending: false })
        .limit(1);
    }

    return new Response(JSON.stringify({
      riskOverview: sections.riskOverview,
      recommendedContact: sections.recommendedContact,
      suggestedOpeningLines: sections.suggestedOpeningLines,
      riskFormulations: sections.riskFormulations,
      nextSteps: sections.nextSteps,
      rawBrief: briefText,
      stored: !dbError,
      notificationSent,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Crisis brief error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function parseBrief(text: string) {
  const result = {
    riskOverview: "",
    recommendedContact: "",
    suggestedOpeningLines: [] as string[],
    riskFormulations: [] as string[],
    nextSteps: [] as string[],
  };

  const lines = text.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("přehled rizik") || lower.includes("1.")) {
      currentSection = "risk"; continue;
    } else if (lower.includes("způsob kontaktu") || lower.includes("2.")) {
      currentSection = "contact"; continue;
    } else if (lower.includes("prvních vět") || lower.includes("3.")) {
      currentSection = "lines"; continue;
    } else if (lower.includes("rizikové formulace") || lower.includes("4.")) {
      currentSection = "formulations"; continue;
    } else if (lower.includes("další") || lower.includes("kroky") || lower.includes("5.")) {
      currentSection = "steps"; continue;
    }

    const trimmed = line.replace(/^[-*•]\s*/, "").trim();
    if (!trimmed) continue;

    switch (currentSection) {
      case "risk":
        result.riskOverview += (result.riskOverview ? " " : "") + trimmed; break;
      case "contact":
        result.recommendedContact += (result.recommendedContact ? " " : "") + trimmed; break;
      case "lines":
        if (trimmed.length > 5) result.suggestedOpeningLines.push(trimmed); break;
      case "formulations":
        if (trimmed.length > 5) result.riskFormulations.push(trimmed); break;
      case "steps":
        if (trimmed.length > 5) result.nextSteps.push(trimmed); break;
    }
  }

  if (!result.riskOverview && !result.recommendedContact) {
    result.riskOverview = text;
  }

  return result;
}
