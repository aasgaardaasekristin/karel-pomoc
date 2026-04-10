import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { reportContent, partName, date, type, recipientEmail } = await req.json();

    if (!reportContent) {
      return new Response(JSON.stringify({ error: "Missing report content" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const targetEmail = recipientEmail || "mujosobniasistentnamiru@gmail.com";
    
    let subject: string;
    if (type === "did_handover") {
      subject = `DID Handover: ${partName || "rozhovor"}, dne: ${date || new Date().toLocaleDateString("cs-CZ")}`;
    } else if (type === "did_message_mom") {
      subject = `Vzkaz od části: ${partName || "neznámá"}, dne: ${date || new Date().toLocaleDateString("cs-CZ")}`;
    } else if (type === "did_message_kata") {
      subject = `Vzkaz pro Káťu od části: ${partName || "neznámá"}, dne: ${date || new Date().toLocaleDateString("cs-CZ")}`;
    } else {
      subject = `Zápis z rozhovoru s částí: ${partName || "neznámá"}, dne: ${date || new Date().toLocaleDateString("cs-CZ")}`;
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    // Format HTML content
    let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${reportContent}</pre>`;

    if (LOVABLE_API_KEY) {
      try {
        const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              {
                role: "system",
                content: SYSTEM_RULES + "\n\nPřeformátuj následující zápis do čistého HTML emailu. Zachovej obsah beze změny, pouze přidej základní HTML formátování (h2, p, ul, li, strong). Vrať POUZE HTML kód bez vysvětlení.",
              },
              { role: "user", content: reportContent },
            ],
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const formatted = data.choices?.[0]?.message?.content;
          if (formatted) {
            htmlContent = formatted.replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
          }
        }
      } catch (e) {
        console.error("AI formatting failed, using plain text:", e);
      }
    }

    // Send email via Resend
    const resend = new Resend(RESEND_API_KEY);
    const { error: sendError } = await resend.emails.send({
      from: "Karel <karel@hana-chlebcova.cz>",
      to: [targetEmail],
      subject,
      html: htmlContent,
    });

    if (sendError) {
      console.error("Resend error:", sendError);
      throw new Error(`Email sending failed: ${sendError.message}`);
    }

    console.log(`Report sent to: ${targetEmail}, subject: ${subject}`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Report odeslán",
      subject,
      to: targetEmail,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Email report error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
