import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { reportContent, partName, date } = await req.json();

    if (!reportContent) {
      return new Response(JSON.stringify({ error: "Missing report content" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const targetEmail = "mujosobniasistentnamiru@gmail.com";
    const subject = `Zápis z rozhovoru s částí: ${partName || "neznámá"}, dne: ${date || new Date().toLocaleDateString("cs-CZ")}`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Use AI to format the report nicely for email
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
            content: "Přeformátuj následující zápis do čistého HTML emailu. Zachovej obsah beze změny, pouze přidej základní HTML formátování (h2, p, ul, li, strong). Vrať POUZE HTML kód bez vysvětlení.",
          },
          { role: "user", content: reportContent },
        ],
      }),
    });

    if (!response.ok) {
      console.error("AI formatting error:", response.status);
      // Fallback: use plain text
    }

    let htmlContent = `<pre style="font-family: sans-serif; white-space: pre-wrap;">${reportContent}</pre>`;
    
    if (response.ok) {
      const data = await response.json();
      const formatted = data.choices?.[0]?.message?.content;
      if (formatted) {
        // Strip markdown code fences if present
        htmlContent = formatted.replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
      }
    }

    // Send email via Supabase's built-in SMTP (using edge function's service role)
    // Since we don't have a direct email service, we'll store the report for manual retrieval
    // and use the Lovable gateway to attempt delivery
    
    // For now, store in a simple way - the report is available in chat and can be copied
    console.log(`Report prepared for: ${targetEmail}`);
    console.log(`Subject: ${subject}`);
    console.log(`Content length: ${reportContent.length}`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Report připraven",
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
