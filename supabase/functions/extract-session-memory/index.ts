import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const { partName, threadId, messages, sessionMode } = await req.json();

    if (!partName || !messages) {
      return new Response(JSON.stringify({ error: "partName and messages required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(messages) || messages.length < 3) {
      return new Response(JSON.stringify({ skipped: true, reason: "too_short" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Deduplicate: skip if this thread was already extracted
    if (threadId) {
      const { data: existing } = await sb.from("session_memory")
        .select("id")
        .eq("thread_id", threadId)
        .limit(1)
        .maybeSingle();
      if (existing) {
        return new Response(JSON.stringify({ skipped: true, reason: "already_extracted" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Load previous memory for context
    const [prevMemoryRes, activePromisesRes] = await Promise.all([
      sb.from("session_memory")
        .select("key_points, unresolved, promises")
        .eq("part_name", partName)
        .order("session_date", { ascending: false })
        .limit(5),
      sb.from("karel_promises")
        .select("promise_text")
        .eq("part_name", partName)
        .eq("status", "active"),
    ]);

    const prevMemory = prevMemoryRes.data || [];
    const activePromises = activePromisesRes.data || [];

    const messagesText = messages.map((m: any) =>
      m.role === "user" ? `[ČÁST]: ${m.content}` : `[KAREL]: ${m.content}`
    ).join("\n");

    const prompt = `Jsi asistent klinického psychologa. Tvůj úkol je extrahovat STRUKTUROVANOU PAMĚŤ z terapeutického sezení.

PRAVIDLA:
- Extrahuj POUZE fakta a pozorování, ne interpretace
- Piš STRUČNĚ — každý bod max 1 věta
- Zaměř se na to co je KLINICKY RELEVANTNÍ
- Nezapomeň na SLIBY které terapeut dal
- Označ co zůstalo NEDOŘEŠENÉ
- Rozpoznej RIZIKOVÉ i POZITIVNÍ signály

PŘEDCHOZÍ PAMĚŤ (pro kontext co už víme):
${prevMemory.map(m => (m.key_points || []).join(", ")).join("\n") || "(první sezení)"}

PŘEDCHOZÍ NEDOŘEŠENÉ:
${prevMemory[0]?.unresolved?.join(", ") || "(nic)"}

AKTIVNÍ SLIBY KARLA:
${activePromises.map(p => p.promise_text).join("\n") || "(žádné)"}

PŘEPIS SEZENÍ:
${messagesText}

VÝSTUP (přesně tento JSON formát):
{
  "key_points": [
    "Arthur mluvil o tom že se bojí tmy",
    "Poprvé zmínil jméno kamaráda (Tomáš)",
    "Reagoval pozitivně na hru s barvami"
  ],
  "emotional_state": "úzkostný ale spolupracující",
  "topics": ["strach ze tmy", "kamarádství", "barvy"],
  "unresolved": [
    "Nedořešili jsme co se stalo v noci"
  ],
  "promises": [
    "Karel slíbil že příště budou kreslit strom"
  ],
  "fulfilled_promises": [
    "Karel splnil slib o hře s barvami"
  ],
  "risk_signals": [],
  "positive_signals": [
    "Poprvé zmínil kamaráda — otevírá se"
  ]
}

Vrať POUZE validní JSON, nic jiného.`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiRes = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi analytický modul Karla. Extrahuj strukturovanou paměť ze sezení. Odpovídej POUZE ve formátu JSON." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!aiRes.ok) throw new Error(`AI error: ${aiRes.status}`);
    const aiData = await aiRes.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "{}";

    // Safe JSON parsing
    let parsed: any = {};
    try {
      const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Fallback: store raw as single key_point
      parsed = { key_points: [rawContent.slice(0, 500)] };
      console.warn("[extract-session-memory] JSON parse failed, using fallback");
    }

    // Enrich with switching events from this thread
    if (threadId) {
      try {
        const { data: threadSwitches } = await sb.from("switching_events")
          .select("original_part, detected_part, confidence")
          .eq("thread_id", threadId);
        if (threadSwitches?.length) {
          const switchNotes = threadSwitches.map((s: any) =>
            `[SWITCHING] Detekován přechod: ${s.original_part} → ${s.detected_part} (jistota: ${s.confidence})`
          );
          parsed.key_points = [...(parsed.key_points || []), ...switchNotes];
          parsed.risk_signals = [...(parsed.risk_signals || []), `Switching detekován (${threadSwitches.length}×)`];
        }
      } catch (e) {
        console.warn("[extract-session-memory] Switching events fetch error:", e);
      }
    }

    // Insert session memory
    const { data: newMemory, error: insertErr } = await sb.from("session_memory").insert({
      part_name: partName,
      thread_id: threadId || null,
      key_points: parsed.key_points || [],
      emotional_state: parsed.emotional_state || null,
      topics: parsed.topics || [],
      unresolved: parsed.unresolved || [],
      promises: parsed.promises || [],
      risk_signals: parsed.risk_signals || [],
      positive_signals: parsed.positive_signals || [],
      session_mode: sessionMode || "karel",
      session_duration_msgs: messages.length,
      auto_generated: true,
    }).select("id").single();

    if (insertErr) throw insertErr;
    const newMemoryId = newMemory?.id;

    // Process NEW promises
    for (const promise of (parsed.promises || [])) {
      await sb.from("karel_promises").insert({
        part_name: partName,
        promise_text: promise,
        context: `Sezení ${new Date().toISOString().slice(0, 10)}`,
        source_session_id: newMemoryId,
      });
    }

    // Process FULFILLED promises
    for (const fulfilled of (parsed.fulfilled_promises || [])) {
      const { data: matches } = await sb.from("karel_promises")
        .select("id, promise_text")
        .eq("part_name", partName)
        .eq("status", "active");

      if (matches?.length) {
        const fulfilledLower = fulfilled.toLowerCase();
        const match = matches.find((m: any) =>
          m.promise_text.toLowerCase().includes(fulfilledLower.slice(0, 20)) ||
          fulfilledLower.includes(m.promise_text.toLowerCase().slice(0, 20))
        );
        if (match) {
          await sb.from("karel_promises")
            .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
            .eq("id", match.id);
        }
      }
    }

    console.log(`[extract-session-memory] Done for ${partName}: ${parsed.key_points?.length || 0} points, ${parsed.promises?.length || 0} promises`);

    return new Response(JSON.stringify({
      success: true,
      keyPoints: parsed.key_points?.length || 0,
      promises: parsed.promises?.length || 0,
      risksDetected: (parsed.risk_signals?.length || 0) > 0,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[extract-session-memory] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
