// karel-child-thread-list-open — FIX 9.K.1b, sekce 1.6
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function pragueDateISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const today = pragueDateISO();

    const { data: threads, error } = await sb
      .from("did_child_thread")
      .select("id, child_part_id, last_active_at, status")
      .eq("status", "open").eq("thread_date", today)
      .order("last_active_at", { ascending: false });
    if (error) throw error;

    const ids = Array.from(new Set((threads ?? []).map(t => t.child_part_id)));
    let nameMap = new Map<string, string>();
    if (ids.length) {
      const { data: parts } = await sb.from("did_part_registry")
        .select("id, part_name, display_name").in("id", ids);
      nameMap = new Map((parts ?? []).map((p: any) => [p.id, p.display_name || p.part_name]));
    }

    const out = (threads ?? []).map(t => ({
      id: t.id,
      child_part_id: t.child_part_id,
      child_part_name: nameMap.get(t.child_part_id) ?? "",
      last_active_at: t.last_active_at,
      status: t.status,
    }));

    return new Response(JSON.stringify({ threads: out }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
