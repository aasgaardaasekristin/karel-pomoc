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

    // Fetch client data
    const [clientRes, sessionsRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];

    // Anti-hallucination guard
    const isCardEmpty = !client?.diagnosis && !client?.key_history && !client?.family_context && !client?.notes;
    if (sessions.length === 0 && isCardEmpty && mode !== "chat") {
      return new Response(JSON.stringify({
        response: `Hani, klient **${clientName}** má v kartotéce prázdnou kartu a žádná sezení.\n\nNemám dost informací pro realistickou simulaci klienta. Nejdřív doplň kartu (diagnóza, anamnéza, kontext) – pak ti připravím tréninkové sezení.`
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sessionHistory = sessions.slice(0, 10).map((s, i) => {
      return [
        `Sezení ${sessions.length - i}: ${s.report_key_theme || "bez tématu"}`,
        s.report_context?.slice(0, 200),
        s.ai_analysis?.slice(0, 400),
      ].filter(Boolean).join(" | ");
    }).join("\n") || "(žádná sezení)";

    const systemPrompt = `Jsi SIMULACE KLIENTA pro tréninkové účely. Hraješ roli klienta "${clientName}" na základě následujících informací:

PROFIL KLIENTA:
- Jméno: ${clientName}
${client?.age ? `- Věk: ${client.age}` : ""}
${client?.gender ? `- Pohlaví: ${client.gender}` : ""}
${client?.diagnosis ? `- Diagnóza: ${client.diagnosis}` : ""}
${client?.key_history ? `- Klíčová anamnéza: ${client.key_history}` : ""}
${client?.family_context ? `- Rodinný kontext: ${client.family_context}` : ""}

HISTORIE SEZENÍ:
${sessionHistory}

POSLEDNÍ ZÁPIS:
${sessionReport?.slice(0, 1500) || "Nedostupný"}

PRAVIDLA SIMULACE:
1. Odpovídej JAKO KLIENT – používej jazyk odpovídající věku, diagnóze a osobnosti
2. Reaguj realisticky – pokud terapeutka položí špatnou otázku, reaguj jako skutečný klient (uzavři se, rozčil se, odveď pozornost...)
3. Postupně odhaluj informace – neříkej vše najednou
4. Pokud terapeutka reaguje dobře, postupně se otevírej
5. Na konci tréninkového bloku (když terapeutka řekne "konec" nebo po ~10 výměnách) PŘEPNI do role Karla a poskytni hodnocení:
   - 📊 **Skóre**: X/10
   - ✅ **Silné stránky**: co terapeutka udělala dobře
   - ⚠️ **Slabé stránky**: co mohla udělat lépe
   - 💡 **Alternativní reakce**: jak mohla reagovat efektivněji
   - 🎯 **Doporučení**: na čem pracovat
   - 💪 **Motivace**: povzbuzení k profesnímu růstu

Teď jsi klient. Začni situací, která je pro tohoto klienta typická.`;

    // Chat mode - stream
    if (mode === "chat" && messages?.length > 0) {
      // Check if training should end (look for "konec" or high message count)
      const lastUserMsg = messages.filter((m: any) => m.role === "user").pop()?.content?.toLowerCase() || "";
      const userMsgCount = messages.filter((m: any) => m.role === "user").length;
      const shouldEvaluate = lastUserMsg.includes("konec") || lastUserMsg.includes("hodnocení") || userMsgCount >= 12;

      const extraInstruction = shouldEvaluate
        ? "\n\n[INSTRUKCE: Terapeutka ukončila trénink. PŘEPNI do role Karla a poskytni detailní hodnocení s bodováním, silnými/slabými stránkami a motivací.]"
        : "";

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt + extraInstruction },
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

    // Initial - start the simulation
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
          { role: "user", content: "Začni simulaci. Jsem terapeutka a právě vstupuješ do mé ordinace." },
        ],
      }),
    });

    if (!aiRes.ok) throw new Error(`AI error: ${aiRes.status}`);
    const aiData = await aiRes.json();

    const intro = `🎯 **Supervizní trénink – ${clientName}**\n\nBudu hrát roli tvého klienta. Reaguj na mě jako na sezení. Až budeš chtít skončit, napiš „konec" a dostaneš hodnocení.\n\n---\n\n` + (aiData.choices?.[0]?.message?.content || "");

    return new Response(JSON.stringify({ response: intro }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-supervision-training error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
