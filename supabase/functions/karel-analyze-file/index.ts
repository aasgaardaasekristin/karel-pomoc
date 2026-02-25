import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const MODE_CONTEXT: Record<string, string> = {
  debrief: "Terapeut je po sezení, zpracovává zážitky. Analyzuj přiložený soubor v kontextu psychohygieny a supervize.",
  supervision: "Supervizní reflexe případu. Analyzuj soubor z hlediska terapeutické práce, přenosu/protipřenosu, diagnostiky.",
  safety: "Režim bezpečnosti a hranic. Analyzuj soubor z hlediska rizik, bezpečnostních signálů, hranic a dokumentace.",
  childcare: "Péče o dítě s DID. Analyzuj soubor v kontextu disociativní poruchy identity, komunikace s dítětem/částmi.",
  research: "Profesní zdroje. Analyzuj soubor a navrhni relevantní odborné zdroje, metody a postupy.",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { attachments, mode, chatContext, userPrompt } = await req.json();

    if (!attachments || attachments.length === 0) {
      return new Response(JSON.stringify({ error: "Žádné přílohy" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const modeContext = MODE_CONTEXT[mode] || MODE_CONTEXT.debrief;

    // Build content parts for multimodal AI request
    const contentParts: any[] = [];

    for (const att of attachments) {
      // Image with base64 data
      if (att.dataUrl && (att.category === "image" || att.category === "screenshot")) {
        contentParts.push({
          type: "image_url",
          image_url: { url: att.dataUrl },
        });
        continue;
      }

      // File from storage - download and include
      if (att.storagePath) {
        const { data: fileData, error } = await supabaseAdmin.storage
          .from("chat-attachments")
          .download(att.storagePath);

        if (error || !fileData) {
          contentParts.push({
            type: "text",
            text: `[Soubor ${att.name} nelze načíst: ${error?.message || "unknown"}]`,
          });
          continue;
        }

        // For audio/video - convert to base64 for multimodal
        if (att.category === "audio") {
          const buffer = await fileData.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
          const format = att.type.includes("mp3") ? "mp3" : att.type.includes("wav") ? "wav" : "webm";
          contentParts.push({
            type: "input_audio",
            input_audio: { data: base64, format },
          });
          continue;
        }

        // For text-based files - include as text
        if (att.type.startsWith("text/") || att.type === "application/json" || att.type === "application/xml") {
          const text = await fileData.text();
          contentParts.push({
            type: "text",
            text: `📄 Obsah souboru "${att.name}":\n\`\`\`\n${text.slice(0, 50000)}\n\`\`\``,
          });
          continue;
        }

        // For images from storage
        if (att.category === "image") {
          const buffer = await fileData.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${att.type};base64,${base64}` },
          });
          continue;
        }

        // For PDFs and other documents - extract text if possible
        if (att.type === "application/pdf") {
          contentParts.push({
            type: "text",
            text: `📎 Přiložen PDF soubor "${att.name}" (${att.size} bytes). Analyzuj na základě dostupných informací a kontextu.`,
          });
          continue;
        }

        // Generic file reference
        contentParts.push({
          type: "text",
          text: `📎 Přiložen soubor "${att.name}" (typ: ${att.type}, velikost: ${att.size} bytes)`,
        });
      }
    }

    // Add user prompt or auto-analyze instruction
    const analyzeText = userPrompt 
      ? userPrompt
      : `Analyzuj přiložené soubory. Popiš co vidíš/slyšíš, identifikuj klíčové body a navrhni doporučení.`;

    contentParts.push({
      type: "text",
      text: `${modeContext}\n\n${chatContext ? `Kontext z chatu:\n${chatContext}\n\n` : ""}${analyzeText}`,
    });

    const systemPrompt = `Jsi Karel – supervizní mentor (Carl Gustav Jung v moderním nastavení). ${modeContext}

Tvůj úkol:
1. Analyzuj přiložené soubory (obrázky, audio, video, dokumenty, screenshoty)
2. Identifikuj klíčové informace relevantní pro terapeutickou práci
3. Poskytni strukturovanou analýzu s praktickými doporučeními
4. U audio/video: analyzuj tón hlasu, emoce, nervové rozpoložení, případné známky stresu
5. U dokumentů: shrň obsah, identifikuj rizika, navrhni postupy
6. U obrázků/screenshotů: popiš co vidíš, zaměř se na relevantní detaily

Odpovídej česky, strukturovaně, profesionálně ale empaticky.`;

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
          { role: "user", content: contentParts },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await response.text();
      console.error("AI error:", response.status, text);
      throw new Error("AI gateway error");
    }

    const data = await response.json();
    const analysis = data.choices?.[0]?.message?.content || "Nepodařilo se analyzovat soubory.";

    return new Response(JSON.stringify({ analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("File analysis error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
