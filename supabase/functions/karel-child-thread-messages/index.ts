// karel-child-thread-messages — FIX 9.K.1b, sekce 1.5
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const thread_id = url.searchParams.get("thread_id");
    if (!thread_id) {
      return new Response(JSON.stringify({ error: "thread_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: thread, error: tErr } = await sb
      .from("did_child_thread")
      .select("id, child_part_id, thread_date, status, opened_at")
      .eq("id", thread_id).maybeSingle();
    if (tErr) throw tErr;
    if (!thread) return new Response(JSON.stringify({ error: "thread not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: part } = await sb.from("did_part_registry")
      .select("part_name, display_name").eq("id", thread.child_part_id).maybeSingle();

    const { data: messages, error: mErr } = await sb
      .from("did_child_thread_message")
      .select("id, sender, content, sent_at")
      .eq("thread_id", thread_id)
      .order("sent_at", { ascending: true });
    if (mErr) throw mErr;

    return new Response(JSON.stringify({
      thread: {
        id: thread.id,
        child_part_id: thread.child_part_id,
        child_part_name: part?.display_name || part?.part_name || "",
        thread_date: thread.thread_date,
        status: thread.status,
        opened_at: thread.opened_at,
      },
      messages: messages ?? [],
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
