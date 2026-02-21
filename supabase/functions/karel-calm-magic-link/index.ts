import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { Resend } from "npm:resend@4.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Rate limit: max 5 requests per email per hour
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = rateLimitMap.get(key);
  if (!rec || now > rec.resetTime) { rateLimitMap.set(key, { count: 1, resetTime: now + windowMs }); return true; }
  if (rec.count >= max) return false;
  rec.count++;
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email } = await req.json();

    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return new Response(JSON.stringify({ error: "Neplatný e-mail" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Rate limit per email
    if (!checkRateLimit(cleanEmail, 5, 3600000)) {
      return new Response(JSON.stringify({ error: "Příliš mnoho požadavků. Zkus to za chvíli." }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit per IP
    const clientIP = req.headers.get("x-forwarded-for") || "unknown";
    if (!checkRateLimit(`ip:${clientIP}`, 10, 3600000)) {
      return new Response(JSON.stringify({ error: "Příliš mnoho požadavků z této adresy." }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Generate secure random token
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, "0")).join("");

    // Store token with 15-minute expiry
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error: insertError } = await supabase.from("calm_access_tokens").insert({
      email: cleanEmail,
      token,
      expires_at: expiresAt,
    });

    if (insertError) {
      console.error("Token insert error:", insertError);
      throw new Error("Failed to create token");
    }

    // Send magic link via Resend
    const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);

    // Build the link URL - use published app URL
    const appUrl = "https://karel-pomoc.lovable.app";
    const magicLink = `${appUrl}/zklidneni?token=${token}`;

    const { error: emailError } = await resend.emails.send({
      from: "Karel <karel@hana-chlebcova.cz>",
      to: [cleanEmail],
      subject: "Tvůj odkaz pro zklidnění",
      html: `
        <div style="font-family: Georgia, 'Times New Roman', serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #ffffff;">
          <h1 style="font-size: 22px; color: #1a1a1a; margin-bottom: 8px;">Ahoj 👋</h1>
          <p style="color: #555; font-size: 15px; line-height: 1.6;">
            Klikni na tlačítko níže a dostaneš se do bezpečného prostoru, kde si můžeš popovídat.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${magicLink}" style="display: inline-block; padding: 14px 32px; background: #8B7355; color: #fff; text-decoration: none; border-radius: 10px; font-size: 16px; font-weight: 500;">
              Chci si popovídat
            </a>
          </div>
          <p style="color: #999; font-size: 12px; line-height: 1.5;">
            Odkaz je platný 15 minut a lze ho použít pouze jednou.<br/>
            Pokud jsi o tento odkaz nežádal/a, můžeš ho ignorovat.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #bbb; font-size: 11px;">
            Hana Chlebcová · Psychoterapie
          </p>
        </div>
      `,
    });

    if (emailError) {
      console.error("Email send error:", emailError);
      throw new Error("Failed to send email");
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Magic link error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Neznámá chyba" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
