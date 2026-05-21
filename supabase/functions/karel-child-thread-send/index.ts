// karel-child-thread-send — FIX 9.K.1b, sekce 1.4
// Přijme zprávu, zavolá opener (identifikace + thread), uloží child message,
// vloží placeholder Karlovu odpověď. Inteligentní odpověď je v FIX 9.K.4.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const raw_text: string = String(body?.raw_text ?? "").trim();
    const sub_mode: string = String(body?.sub_mode ?? "cast");
    const input_thread_id: string | null = body?.thread_id ?? null;

    if (!raw_text) {
      return new Response(JSON.stringify({ error: "raw_text required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 1) opener
    const openerRes = await fetch(`${SUPABASE_URL}/functions/v1/karel-child-thread-opener`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ raw_text, sub_mode }),
    });
    const openerJson = await openerRes.json();
    if (!openerRes.ok || openerJson?.needs_clarification) {
      return new Response(JSON.stringify(openerJson),
        { status: openerRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const thread_id: string = openerJson.thread_id;

    // 2) insert child message (opener již vložil první ze svého volání pokud is_new_thread;
    //    abychom neměli duplicitu, vkládáme jen pokud thread již existoval).
    if (!openerJson.is_new_thread) {
      await sb.from("did_child_thread_message").insert({
        thread_id, sender: "child", content: raw_text,
      });
    }

    // 3) touch last_active_at
    await sb.from("did_child_thread")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", thread_id);

    // 4) placeholder Karlova odpověď (FIX 9.K.4 to nahradí inteligencí)
    const child_name = openerJson.child_part_name ?? "kamaráde";
    const placeholder = `Slyším tě, ${child_name}. Mluv se mnou.`;
    await sb.from("did_child_thread_message").insert({
      thread_id, sender: "karel", content: placeholder,
    });

    const switched_from_thread_id =
      input_thread_id && input_thread_id !== thread_id ? input_thread_id : undefined;

    return new Response(JSON.stringify({
      thread_id,
      child_part_id: openerJson.child_part_id,
      child_part_name: openerJson.child_part_name,
      is_new_thread: openerJson.is_new_thread,
      switched_from_thread_id,
      karel_responding: false, // placeholder už uložen synchronně
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("[child-thread-send] error:", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
