import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { z } from "https://esm.sh/zod@3.25.76";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BodySchema = z.object({
  conversationId: z.string().uuid(),
  requestedTitle: z.string().trim().max(120).nullable().optional(),
  section: z.string().trim().min(1).max(32).default("hana"),
  subMode: z.string().trim().min(1).max(32).default("personal"),
});

async function requireAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  return { user };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { conversationId, requestedTitle, section, subMode } = parsed.data;
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: conversation, error: conversationError } = await service
      .from("karel_hana_conversations")
      .select("id, user_id, messages, preview, thread_label")
      .eq("id", conversationId)
      .eq("user_id", auth.user.id)
      .single();

    if (conversationError || !conversation) {
      return new Response(JSON.stringify({ error: "Vlákno nebylo nalezeno" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const transcript = messages
      .map((message: any) => `${message?.role === "assistant" ? "Karel" : "Hani"}: ${String(message?.content ?? "")}`)
      .join("\n\n")
      .slice(0, 16000);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const aiResult = await callAiForJson<{ title: string | null; extracted_context: string | null }>({
      callerName: "karel-save-topic",
      apiKey: LOVABLE_API_KEY,
      model: "google/gemini-2.5-flash",
      maxRetries: 1,
      fallback: {
        title: requestedTitle || conversation.thread_label || conversation.preview || "Uložené téma",
        extracted_context: transcript.slice(0, 2000),
      },
      requiredKeys: ["title", "extracted_context"],
      systemPrompt: `Jsi modul pro extrakci rozpracovaných témat z terapeutického vlákna. Vrať pouze JSON se strukturou {"title": string, "extracted_context": string}. Název max 5 slov. extracted_context max 2000 znaků, pouze nejdůležitější kontext pro navázání v dalším hovoru, bez balastu.`,
      userPrompt: `Preferovaný název od uživatelky: ${requestedTitle || "(žádný)"}\n\nVlákno:\n${transcript}`,
    });

    const finalTitle = (requestedTitle || aiResult.data?.title || conversation.thread_label || conversation.preview || "Uložené téma").trim().slice(0, 120);
    const extractedContext = (aiResult.data?.extracted_context || transcript).trim().slice(0, 2000);

    const { data: topic, error: topicError } = await service
      .from("karel_saved_topics")
      .insert({
        user_id: auth.user.id,
        title: finalTitle,
        extracted_context: extractedContext,
        source_thread_id: conversation.id,
        section,
        sub_mode: subMode,
        pending_drive_sync: true,
        is_active: true,
      })
      .select("id, title")
      .single();

    if (topicError || !topic) throw topicError || new Error("Uložení tématu selhalo");

    return new Response(JSON.stringify({ success: true, topic }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[karel-save-topic] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});