import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

    const { clientId, clientName, sessionReport, messages, mode } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch full client history
    const [clientRes, sessionsRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];

    const fullHistory = sessions.slice(0, 15).map((s, i) => {
      return [
        `--- Sezení ${sessions.length - i} (${s.session_date}) ---`,
        s.report_context ? `Kontext: ${s.report_context}` : null,
        s.report_key_theme ? `Téma: ${s.report_key_theme}` : null,
        s.ai_analysis ? `Analýza: ${s.ai_analysis.slice(0, 600)}` : null,
        s.report_interventions_tried ? `Intervence: ${s.report_interventions_tried}` : null,
        s.report_risks?.length ? `Rizika: ${s.report_risks.join(", ")}` : null,
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const systemPrompt = `Jsi Karel, zkušený klinický supervizor s 30letou praxí. Terapeutka Hanka tě žádá o odbornou konzultaci k jejímu klientovi. Tvá role:

1. **Objektivní třetí strana** – poskytni nezaujatý pohled na případ
2. **Upozorni na chyby** – pokud v záznamech vidíš problematické reakce, nevhodné intervence nebo přehlédnutá rizika, řekni to přímo ale empaticky
3. **Klíčové body** – identifikuj, na co se má u klienta soustředit
4. **Supervizní pohled** – pomoz jí pochopit dynamiku vztahu terapeut-klient
5. **Korekce** – pokud má terapeutka zkreslený pohled, korektně ji přesměruj
6. **Příprava** – pomoz jí připravit se na příští sezení, korigovat postoj

Buď upřímný, ale podporující. Hanka potřebuje slyšet pravdu, aby mohla růst.

KLIENT: ${clientName}
${client?.age ? `Věk: ${client.age}` : ""}
${client?.diagnosis ? `Diagnóza: ${client.diagnosis}` : ""}
${client?.therapy_type ? `Typ terapie: ${client.therapy_type}` : ""}
${client?.key_history ? `Anamnéza: ${client.key_history}` : ""}
${client?.family_context ? `Rodinný kontext: ${client.family_context}` : ""}

HISTORIE SEZENÍ:
${fullHistory}

POSLEDNÍ ZÁPIS:
${sessionReport?.slice(0, 2000) || "Nedostupný"}`;

    // Chat mode - stream
    if (mode === "chat" && messages?.length > 0) {
      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          stream: true,
        }),
      });

      if (!response.ok) throw new Error(`AI error: ${response.status}`);
      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // Initial analysis – with retry
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
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
            {
              role: "user",
              content: `Haničko, přečetl jsem si celou kartu klienta ${clientName} a všechna sezení. Tady je můj odborný pohled:\n\n1. Co vidím jako klíčové v tomto případu\n2. Na co bych tě upozornil\n3. Co bych doporučil změnit v přístupu\n4. Na co se soustředit příště\n\nPiš.`,
            },
          ],
        }),
      });

      const bodyText = await aiRes.text();
      if (!aiRes.ok) {
        lastErr = `AI ${aiRes.status}: ${bodyText.slice(0, 200)}`;
        console.error(`Attempt ${attempt + 1} failed:`, lastErr);
        if (aiRes.status === 429 || aiRes.status >= 500) continue;
        throw new Error(lastErr);
      }

      if (!bodyText || bodyText.trim().length === 0) {
        lastErr = "Empty AI response";
        console.error(`Attempt ${attempt + 1}: empty body`);
        continue;
      }

      const aiData = JSON.parse(bodyText);
      return new Response(JSON.stringify({ response: aiData.choices?.[0]?.message?.content || "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    throw new Error(`AI failed after 3 attempts: ${lastErr}`);
  } catch (e) {
    console.error("karel-supervision-discuss error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
