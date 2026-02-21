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
    const { token } = await req.json();

    if (!token || typeof token !== "string" || token.length !== 64) {
      return new Response(JSON.stringify({ valid: false, error: "Neplatný token" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Find token
    const { data, error } = await supabase
      .from("calm_access_tokens")
      .select("id, email, used, expires_at")
      .eq("token", token)
      .single();

    if (error || !data) {
      return new Response(JSON.stringify({ valid: false, error: "Odkaz nebyl nalezen" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (data.used) {
      return new Response(JSON.stringify({ valid: false, error: "Tento odkaz již byl použit" }), {
        status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (new Date(data.expires_at) < new Date()) {
      return new Response(JSON.stringify({ valid: false, error: "Platnost odkazu vypršela" }), {
        status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mark token as used
    await supabase.from("calm_access_tokens").update({ used: true }).eq("id", data.id);

    return new Response(JSON.stringify({ valid: true, email: data.email }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Verify error:", error);
    return new Response(
      JSON.stringify({ valid: false, error: "Chyba ověření" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
