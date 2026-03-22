import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const { clientId, completedTasks } = await req.json();
    if (!clientId || !completedTasks?.length) throw new Error("clientId and completedTasks required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch current client card
    const { data: client } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (!client) throw new Error("Client not found");

    const answersText = completedTasks.map((t: any) =>
      `Otázka: ${t.question}\nOdpověď: ${t.answer}`
    ).join("\n\n");

    const systemPrompt = `Jsi Karel, klinický supervizor. Terapeut zodpověděl dotazníkové otázky ke klientovi. Tvým úkolem je rozhodnout, kam v kartě klienta každá odpověď patří, a vrátit aktualizace.

AKTUÁLNÍ KARTA KLIENTA:
- Diagnóza: ${client.diagnosis || "(prázdné)"}
- Klíčová anamnéza: ${client.key_history || "(prázdné)"}
- Rodinný kontext: ${client.family_context || "(prázdné)"}
- Poznámky: ${client.notes || "(prázdné)"}

Vrať validní JSON:
{
  "updates": {
    "diagnosis": "nová hodnota nebo null pokud beze změny",
    "key_history": "nová hodnota nebo null",
    "family_context": "nová hodnota nebo null",
    "notes": "nová hodnota nebo null"
  },
  "summary": "co jsi kam zařadil (krátce)"
}

PRAVIDLA:
- PŘIDÁVEJ k existujícímu textu, NENAHRAZUJ ho
- Pokud existující pole obsahuje text, přidej novou informaci na konec
- Pokud odpověď nepatří do žádného pole, přidej do notes
- Vrať null pro pole, která se nemění`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: answersText },
        ],
      }),
    });

    if (!aiRes.ok) throw new Error(`AI error: ${aiRes.status}`);

    const aiData = await aiRes.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    let parsed: any;
    try {
      const jsonStr = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error("AI vrátil nevalidní JSON");
    }

    // Apply updates to client card
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.updates || {})) {
      if (value && typeof value === "string" && ["diagnosis", "key_history", "family_context", "notes"].includes(key)) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabase.from("clients").update(updates).eq("id", clientId);
      if (updateError) console.error("Client update error:", updateError);
    }

    // Mark tasks as done
    const taskIds = completedTasks.map((t: any) => t.taskId);
    const { error: taskError } = await supabase.from("client_tasks")
      .update({ status: "done" })
      .in("id", taskIds);
    if (taskError) console.error("Task update error:", taskError);

    return new Response(JSON.stringify({
      success: true,
      summary: parsed.summary || "Odpovědi zapracovány",
      updatedFields: Object.keys(updates),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-task-redistribute error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
