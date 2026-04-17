import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";
import { createObservation } from "../_shared/observations.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

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

    const memoryFallback = {
      key_points: ["(automatická extrakce selhala)"],
      emotional_state: "neznámý",
      topics: [],
      unresolved: [],
      promises: [],
      fulfilled_promises: [],
      risk_signals: [],
      positive_signals: [],
    };

    const aiResult = await callAiForJson({
      systemPrompt: "Jsi analytický modul Karla. Extrahuj strukturovanou paměť ze sezení. Odpovídej POUZE ve formátu JSON.",
      userPrompt: prompt,
      apiKey: LOVABLE_API_KEY,
      requiredKeys: ["key_points", "emotional_state", "topics"],
      knownPartNames: [partName],
      maxRetries: 1,
      fallback: memoryFallback,
      callerName: "extract-session-memory",
    });

    if (!aiResult.success) {
      await sb.from("ai_error_log").insert({
        caller: "extract-session-memory",
        error_type: "json_parse_failed",
        error_message: aiResult.error,
        raw_output: aiResult.data ? JSON.stringify(aiResult.data) : null,
        context: { partName, messageCount: messages.length },
      }).catch(() => {});
    }

    const parsed: any = aiResult.data || memoryFallback;

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

    // ═══ FÁZE 2B: Propagate to evidence pipeline + therapist memory ═══
    try {
      const sourceRefBase = `session_memory_${newMemoryId}`;
      // Each key_point becomes an observation about the part
      for (const kp of (parsed.key_points || []).slice(0, 8)) {
        if (typeof kp !== "string" || kp.length < 8) continue;
        try {
          const obsId = await createObservation(sb, {
            subject_type: "part",
            subject_id: partName.toLowerCase(),
            source_type: "session",
            source_ref: `${sourceRefBase}_${kp.slice(0, 30)}`,
            fact: kp.slice(0, 600),
            evidence_level: "D2",
            confidence: 0.7,
            time_horizon: "0_14d",
          });
          await sb.from("did_observations").update({
            freshness_band: "recent",
            confidence_band: "medium",
            change_type: "new",
            needs_verification: false,
            evidence_kind: "FACT",
          }).eq("id", obsId);
        } catch (_) { /* non-fatal */ }
      }

      // Risks → governed write into KARLOVY_POZNATKY for therapist visibility
      const therapistKey = sessionMode === "kata" ? "KATA" : "HANKA";
      const today = new Date().toISOString().slice(0, 10);
      const risks = (parsed.risk_signals || []).filter((r: any) => typeof r === "string" && r.length > 5);
      if (risks.length > 0) {
        const docKey = `PAMET_KAREL/DID/${therapistKey}/KARLOVY_POZNATKY`;
        const content = `\n=== SEKCE C — [DEDUKCE] [NOVÉ] [STŘEDNÍ JISTOTA] [AKUTNÍ] [VYŽADUJE OVĚŘENÍ] ${today} ===\nRizikové signály ze sezení s ${partName}:\n${risks.map((r: string) => `- ${r}`).join("\n")}\n→ Implikace: vyžaduje pozornost terapeutky před dalším sezením.`;
        const governed = encodeGovernedWrite(content, {
          source_type: "session_memory_extraction",
          source_id: `session_${newMemoryId}_risks`,
          content_type: "therapist_memory_note",
          subject_type: "part",
          subject_id: partName.toLowerCase(),
        });
        await sb.from("did_pending_drive_writes").insert({
          target_document: docKey,
          content: governed,
          priority: "high",
          status: "pending",
          write_type: "append",
        }).then(({ error }) => {
          if (error) console.warn("[extract-session-memory] risk writeback failed:", error.message);
        });
      }

      // FÁZE 2C: unresolved → pending questions ALWAYS (independent of risks).
      // Risks and unresolved are two different things; an unanswered question
      // is not necessarily a risk signal.
      for (const ur of (parsed.unresolved || []).slice(0, 3)) {
        if (typeof ur !== "string" || ur.length < 8) continue;
        await sb.from("did_pending_questions").insert({
          question: `Nedořešené ze sezení s ${partName}: ${ur.slice(0, 240)}`,
          context: `Session ${newMemoryId}, ${today}`,
          subject_type: "part",
          subject_id: partName.toLowerCase(),
          directed_to: therapistKey === "KATA" ? "kata" : "hanka",
          status: "open",
          expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        }).then(({ error }) => {
          if (error) console.warn("[extract-session-memory] pending question failed:", error.message);
        });
      }
    } catch (evErr) {
      console.warn("[extract-session-memory] evidence propagation failed (non-fatal):", evErr);
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
