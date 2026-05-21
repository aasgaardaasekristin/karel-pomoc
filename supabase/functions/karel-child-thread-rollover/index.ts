// karel-child-thread-rollover — FIX 9.K.1, sekce 1.4
// Zavře všechna 'open' vlákna, jejichž thread_date je starší než dnešek v Europe/Prague.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const pragueToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    const { data, error } = await sb
      .from("did_child_thread")
      .update({ status: "closed_rollover", closed_at: new Date().toISOString() })
      .eq("status", "open")
      .lt("thread_date", pragueToday)
      .select("id");
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true, closed: data?.length ?? 0, prague_today: pragueToday,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
