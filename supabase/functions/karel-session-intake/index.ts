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

    const { clientId, inputType, textInput, audioBase64, sessionDate, therapistName, revisionRequest, mediaContext } = await req.json();
    if (!clientId) throw new Error("clientId required");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Fetch client data + previous sessions + tasks
    const [clientRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase.from("client_sessions").select("*").eq("client_id", clientId).order("session_date", { ascending: false }).limit(20),
      supabase.from("client_tasks").select("*").eq("client_id", clientId).eq("status", "planned"),
    ]);

    const client = clientRes.data;
    const sessions = sessionsRes.data || [];
    const pendingTasks = tasksRes.data || [];
    const sessionNumber = sessions.length + 1;

    // Build client context
    const isCardEmpty = !client?.diagnosis && !client?.key_history && !client?.family_context && !client?.notes;
    const emptyCardWarning = isCardEmpty
      ? "\n⚠️ UPOZORNĚNÍ: Karta klienta je zatím prázdná. Vygeneruj dotazníkové otázky s vysokou prioritou pro doplnění karty."
      : "";

    const sessionsContext = sessions.slice(0, 10).map((s: any, i: number) =>
      `--- Sezení ${sessions.length - i} (${s.session_date}) ---\n${s.ai_analysis?.slice(0, 400) || s.notes || "(bez záznamu)"}`
    ).join("\n\n") || "(žádná předchozí sezení)";

    const pendingTasksContext = pendingTasks.length > 0
      ? pendingTasks.map((t: any) => `- ${t.task} (${t.status})`).join("\n")
      : "(žádné otevřené úkoly)";

    // Build user content
    const userContent: any[] = [];

    if (inputType === "audio" && audioBase64) {
      userContent.push({
        type: "input_audio",
        input_audio: { data: audioBase64, format: "webm" },
      });
      userContent.push({
        type: "text",
        text: "Výše je audio záznam terapeuta popisujícího průběh sezení. Přepiš ho a analyzuj.",
      });
    } else {
      userContent.push({
        type: "text",
        text: `Terapeutův popis sezení:\n\n${textInput || "(prázdný vstup)"}`,
      });
    }

    // Append revision instructions if present
    if (revisionRequest) {
      userContent.push({ type: "text", text: `\n\nINSTRUKCE K ÚPRAVĚ: ${revisionRequest}` });
    }

    // Append media analyses if present
    if (mediaContext) {
      userContent.push({ type: "text", text: `\n\n📎 ANALÝZY MÉDIÍ ZE SEZENÍ:\n${mediaContext}` });
    }

    const systemPrompt = `Jsi Karel, klinický supervizor. Terapeutka ti posílá popis toho, co proběhlo na sezení s klientem. Tvým úkolem je vytvořit strukturovaný zápis ze sezení.
${emptyCardWarning}

KLIENT: ${client?.name || "neznámý"}
${client?.age ? `Věk: ${client.age}` : ""}
${client?.diagnosis ? `Diagnóza: ${client.diagnosis}` : ""}
${client?.therapy_type ? `Typ terapie: ${client.therapy_type}` : ""}
${client?.key_history ? `Anamnéza: ${client.key_history}` : ""}
${client?.family_context ? `Rodinný kontext: ${client.family_context}` : ""}
${client?.notes ? `Poznámky: ${client.notes}` : ""}

PŘEDCHOZÍ SEZENÍ:
${sessionsContext}

OTEVŘENÉ ÚKOLY:
${pendingTasksContext}

KRITICKÉ PRAVIDLO: Vycházej VÝHRADNĚ z popisu terapeuta. NEVYMÝŠLEJ si detaily, události ani citáty, které terapeut neřekl. Pokud ti něco chybí, zařaď to do dotazníku.

Pole "summary" MUSÍ obsahovat markdown text s nadpisy ## pro každou sekci BIRP+S. Každá sekce na novém řádku. NEPIŠ prefix "Strukturovaný zápis ve formátu BIRP+S:" — začni rovnou sekcí ## B.

Tvůj výstup MUSÍ být validní JSON v tomto formátu:
{
  "transcription": "přepis audia, pokud bylo audio, jinak null",
  "summary": "## B – PREZENTACE KLIENTA\n[chování, vzhled, nálada]\n\n## I – INTERVENCE\n[techniky]\n\n## R – ODPOVĚĎ KLIENTA\n[reakce, posun]\n\n## P – PLÁN\n[zaměření příště]\n\n## S – SUPERVIZNÍ POZNÁMKA (Karel)\n[hypotézy, rizika]",
  "analysis": "analýza v kontextu celkové terapie a předchozích sezení",
  "diagnosticHypothesis": {
    "hypothesis": "diagnostická hypotéza na základě pozorování",
    "confidence": "low|medium|high",
    "missingData": ["co chybí pro potvrzení"]
  },
  "therapeuticRecommendations": [
    {"approach": "doporučený přístup", "reason": "proč"}
  ],
  "nextSessionFocus": ["na co se zaměřit příště"],
  "questionnaire": [
    {"question": "otázka k doplnění", "category": "card|history|medication|family|other", "priority": "high|medium|low"}
  ],
  "clientTasks": ["co si klient odnáší domů"]
}`;

    // Call AI
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
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!aiRes.ok) {
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit – zkus to za chvíli" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Nedostatek kreditů" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI error: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    // Parse JSON from AI response (strip markdown code fences if present)
    let parsed: any;
    try {
      const jsonStr = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = {
        summary: rawContent,
        analysis: "",
        diagnosticHypothesis: { hypothesis: "", confidence: "low", missingData: [] },
        therapeuticRecommendations: [],
        nextSessionFocus: [],
        questionnaire: [],
        clientTasks: [],
      };
    }

    // Return AI result — DB save is handled by the frontend after review
    return new Response(JSON.stringify({
      sessionNumber,
      sessionDate: sessionDate || new Date().toISOString().split("T")[0],
      transcription: parsed.transcription || null,
      sessionRecord: {
        method: inputType || "text",
        summary: parsed.summary || "",
        analysis: parsed.analysis || "",
        diagnosticHypothesis: parsed.diagnosticHypothesis || {},
        therapeuticRecommendations: parsed.therapeuticRecommendations || [],
        nextSessionFocus: parsed.nextSessionFocus || [],
      },
      questionnaire: parsed.questionnaire || [],
      clientTasks: parsed.clientTasks || [],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("karel-session-intake error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
