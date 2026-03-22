import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function parseTasks(text: string, heading: string): { task: string; priority: string }[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = text.match(new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n###|$)`));
  if (!section) return [];
  return [...section[1].matchAll(/- (?:\[(HIGH|MEDIUM|LOW)\] )?(.+)/gi)]
    .map(m => ({ task: m[2].trim(), priority: (m[1] || "medium").toLowerCase() }));
}

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

    const { clientId, clientName, chatMessages, caseSummary } = await req.json();
    if (!clientId || !chatMessages) throw new Error("clientId and chatMessages required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch client data for context
    const { data: client } = await supabase.from("clients").select("*").eq("id", clientId).single();
    const { count } = await supabase.from("client_sessions").select("id", { count: "exact", head: true }).eq("client_id", clientId);

    const chatTranscript = chatMessages
      .map((m: any) => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
      .join("\n\n");

    const prompt = `Jsi Karel, klinický supervizor. Právě skončilo sezení s klientem. Na základě přepisu chatu z live sezení vytvoř PROFESIONÁLNÍ ZÁPIS ZE SEZENÍ v češtině.

KRITICKÉ PRAVIDLO: Vycházej VÝHRADNĚ z přepisu live sezení níže. NEVYMÝŠLEJ si nic, co v přepisu není. Pokud v přepisu něco chybí, napiš "nebylo zaznamenáno" – NIKDY nefabuluj.

KLIENT: ${clientName}
${client?.diagnosis ? `Diagnóza: ${client.diagnosis}` : ""}
${client?.therapy_type ? `Typ terapie: ${client.therapy_type}` : ""}
${caseSummary ? `\nSHRNUTÍ PŘÍPADU:\n${caseSummary}` : ""}

PŘEPIS LIVE SEZENÍ:
${chatTranscript}

Vytvoř zápis v tomto formátu:

## Zápis ze sezení
**Datum:** ${new Date().toLocaleDateString("cs-CZ")}
**Klient:** ${clientName}
**Číslo sezení:** ${(count ?? 0) + 1}

### Průběh sezení
(Co se dělo, hlavní témata, reakce klienta)

### Klíčová pozorování
(Co Karel zaznamenal – neverbální signály, emoční dynamika, přenosy)

### Použité intervence
(Jaké metody/techniky byly použity)

### Rizika a varování
(Pokud byla identifikována)

### Doporučení pro příští sezení
- **Návrh struktury** (60 min): rozložení času
- **Metody a pomůcky**: co připravit
- **Klíčové otázky**: na co se zaměřit
- **Co zjistit příště**: co ověřit

### Karlovy poznámky
(Vlastní postřehy supervizora – co šlo dobře, co zlepšit)

### Úkoly pro terapeuta
- [HIGH/MEDIUM/LOW] popis úkolu (co ověřit, zjistit, připravit)

### Úkoly pro klienta
- popis domácího úkolu nebo cvičení`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi klinický supervizor Karel. Piš profesionálně, odborně, v češtině. Zápis musí být praktický a užitečný pro příští sezení. NIKDY si nevymýšlej události, které nejsou v přepisu." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!aiRes.ok) {
      console.error("AI error:", aiRes.status, await aiRes.text());
      throw new Error("AI gateway error");
    }

    const aiData = await aiRes.json();
    const report = aiData.choices?.[0]?.message?.content || "";

    // Parse and insert tasks
    const therapistTasks = parseTasks(report, "### Úkoly pro terapeuta");
    const clientTasks = parseTasks(report, "### Úkoly pro klienta");
    const nextSession = (count ?? 0) + 2;

    if (therapistTasks.length + clientTasks.length > 0) {
      const taskRows = [
        ...therapistTasks.map(t => ({
          client_id: clientId,
          task: t.task,
          task_type: "therapist_question",
          priority: t.priority,
          for_session: nextSession,
          status: "planned",
        })),
        ...clientTasks.map(t => ({
          client_id: clientId,
          task: t.task,
          task_type: "client_homework",
          priority: t.priority,
          for_session: nextSession,
          status: "planned",
        })),
      ];
      const { error: taskError } = await supabase.from("client_tasks").insert(taskRows);
      if (taskError) console.error("Task insert error:", taskError);
    }

    // Save session to kartoteka
    const { error: insertError } = await supabase.from("client_sessions").insert({
      client_id: clientId,
      session_number: (count ?? 0) + 1,
      ai_analysis: report,
      ai_hypotheses: chatTranscript,
      notes: `Live sezení s Karlem – ${new Date().toLocaleDateString("cs-CZ")}`,
    });

    if (insertError) console.error("Insert error:", insertError);

    return new Response(JSON.stringify({ report, tasks: [...therapistTasks, ...clientTasks] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-session-finalize error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
