// karel-child-thread-opener — FIX 9.K.1
// Identifikuje dítě podle textu (explicit name → style match → manual confirm)
// a založí / vrátí denní vlákno (did_child_thread) per Europe/Prague.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function pragueDateISO(): string {
  // YYYY-MM-DD v zóně Europe/Prague
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date());
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

interface PartRow { id: string; part_name: string; display_name: string; aliases: string[] | null; }

function tryExplicitName(text: string, parts: PartRow[]): PartRow | null {
  const t = " " + norm(text) + " ";
  for (const p of parts) {
    const candidates = [p.part_name, p.display_name, ...(p.aliases || [])]
      .filter(Boolean).map(norm).filter(x => x.length >= 3);
    for (const c of candidates) {
      // whole-word-ish match
      const re = new RegExp("(^|[^a-z0-9])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)");
      if (re.test(t)) return p;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const raw_text: string = String(body?.raw_text ?? "").trim();
    const sub_mode: string = String(body?.sub_mode ?? "cast");
    if (!raw_text) {
      return new Response(JSON.stringify({ error: "raw_text required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (sub_mode !== "cast") {
      return new Response(JSON.stringify({ error: "sub_mode must be 'cast'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Načti aktivní/spící části (jen co může být dítě v Kluci)
    const { data: parts, error: pErr } = await sb
      .from("did_part_registry")
      .select("id, part_name, display_name, aliases");
    if (pErr) throw pErr;
    const partList = (parts ?? []) as PartRow[];

    // KROK 1: identifikace
    let matched: PartRow | null = tryExplicitName(raw_text, partList);
    let identification_method: "explicit_name" | "style_match" | "manual_confirm" = "explicit_name";
    let identification_confidence = 0.95;

    if (!matched) {
      // style_match placeholder — FIX 8 identityAddressát zde není volaný (mimo scope 9.K.1).
      // Vracíme needs_clarification → UI/Karel pošle šetrnou otázku.
      return new Response(JSON.stringify({
        needs_clarification: true,
        message: "Ahoj. Vítej. Můžeš mi napsat, jak ti dnes říkáš?",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // KROK 2: najdi / vytvoř denní vlákno
    const thread_date = pragueDateISO();
    let is_new_thread = false;

    const { data: existing } = await sb
      .from("did_child_thread")
      .select("id")
      .eq("child_part_id", matched.id)
      .eq("thread_date", thread_date)
      .eq("status", "open")
      .maybeSingle();

    let thread_id: string;
    if (existing?.id) {
      thread_id = existing.id;
      await sb.from("did_child_thread")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", thread_id);
    } else {
      // decision trace
      const { data: dt } = await sb.from("decision_traces").insert({
        triggered_by: "thread_open",
        snapshot_ref: { part_id: matched.id, part_name: matched.part_name },
        reasoning: `Identified via ${identification_method} from raw_text`,
        outcome: "thread_created",
      }).select("id").single();

      const { data: ins, error: iErr } = await sb.from("did_child_thread").insert({
        child_part_id: matched.id,
        thread_date,
        status: "open",
        identification_method,
        identification_confidence,
        decision_trace_id: dt?.id ?? null,
      }).select("id").single();
      if (iErr) throw iErr;
      thread_id = ins!.id;
      is_new_thread = true;
    }

    // První zpráva do vlákna
    await sb.from("did_child_thread_message").insert({
      thread_id,
      sender: "child",
      content: raw_text,
    });

    // KROK 3: kontext loader — FIX 9.K.2 (zde jen no-op, vrátí se asynchronně)
    return new Response(JSON.stringify({
      thread_id,
      child_part_id: matched.id,
      child_part_name: matched.part_name,
      is_new_thread,
      identification_method,
      identification_confidence,
      thread_date,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("[child-thread-opener] error:", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
