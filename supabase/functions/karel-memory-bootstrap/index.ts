import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Memory Bootstrap – Fáze 5
 * 
 * Jednorázová funkce pro naplnění kognitivního paměťového systému
 * z existujících dat:
 * 1. DID vlákna (did_threads) → epizody + entity
 * 2. DID konverzace (did_conversations) → epizody
 * 3. Hana konverzace (karel_hana_conversations) → epizody
 * 
 * Spouští se manuálně. Zpracovává data v dávkách aby nedošlo k timeoutu.
 * Podporuje parametr `phase`: "threads" | "conversations" | "hana" | "consolidate"
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: any = {};
  try { body = await req.json(); } catch { /* ok */ }

  const phase = body.phase || "threads";
  const batchSize = body.batchSize || 10;
  const offset = body.offset || 0;

  console.log(`[bootstrap] Phase: ${phase}, batch: ${batchSize}, offset: ${offset}, user: ${user.id}`);

  try {
    let result: any;

    switch (phase) {
      case "threads":
        result = await bootstrapThreads(sb, user.id, LOVABLE_API_KEY, batchSize, offset);
        break;
      case "conversations":
        result = await bootstrapConversations(sb, user.id, LOVABLE_API_KEY, batchSize, offset);
        break;
      case "hana":
        result = await bootstrapHanaConversations(sb, user.id, LOVABLE_API_KEY, batchSize, offset);
        break;
      case "consolidate":
        result = await runConsolidation(sb, user.id, LOVABLE_API_KEY);
        break;
      default:
        return new Response(JSON.stringify({ error: `Unknown phase: ${phase}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[bootstrap] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ═══ PHASE 1: DID Threads → Episodes ═══
async function bootstrapThreads(sb: any, userId: string, apiKey: string, batchSize: number, offset: number) {
  const { data: threads, count } = await sb
    .from("did_threads")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("started_at", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (!threads || threads.length === 0) {
    return { phase: "threads", status: "complete", processed: 0, total: count || 0, next_offset: null };
  }

  let episodesCreated = 0;
  const errors: string[] = [];

  for (const thread of threads) {
    try {
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      if (msgs.length < 2) continue; // skip empty/trivial threads

      const excerpt = msgs
        .filter((m: any) => typeof m === "object" && m.content)
        .slice(0, 12)
        .map((m: any) => `[${m.role}]: ${(m.content as string).slice(0, 300)}`)
        .join("\n");

      if (!excerpt.trim()) continue;

      const episode = await extractEpisodeFromText(
        apiKey,
        `DID vlákno s částí "${thread.part_name}" (režim: ${thread.sub_mode}), datum: ${thread.started_at}`,
        excerpt,
        "DID"
      );

      if (episode) {
        const { error } = await sb.from("karel_episodes").insert({
          user_id: userId,
          domain: "DID",
          hana_state: episode.hana_state || "EMO_KLIDNA",
          participants: [thread.part_name, ...(episode.participants || [])],
          summary_user: episode.summary_user || `Rozhovor s ${thread.part_name}`,
          summary_karel: episode.summary_karel || "",
          reasoning_notes: episode.reasoning_notes || "",
          emotional_intensity: Math.min(5, Math.max(1, episode.emotional_intensity || 3)),
          tags: [...(episode.tags || []), "bootstrap", `part:${thread.part_name}`, thread.sub_mode],
          derived_facts: episode.derived_facts || [],
          actions_taken: episode.actions_taken || [],
          outcome: episode.outcome || "",
          timestamp_start: thread.started_at,
          timestamp_end: thread.last_activity_at,
          source_conversation_id: `did_thread:${thread.id}`,
          is_archived: true, // already historical
        });
        if (error) errors.push(`thread ${thread.id}: ${error.message}`);
        else episodesCreated++;
      }
    } catch (e) {
      errors.push(`thread ${thread.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hasMore = (offset + batchSize) < (count || 0);
  
  // Log
  await sb.from("karel_memory_logs").insert({
    user_id: userId,
    log_type: "bootstrap_threads",
    summary: `Bootstrap DID threads batch ${offset}-${offset + threads.length}: ${episodesCreated} episodes created`,
    episodes_created: episodesCreated,
    errors,
    details: { phase: "threads", offset, batch_size: batchSize, total: count },
  });

  return {
    phase: "threads",
    status: hasMore ? "in_progress" : "complete",
    processed: threads.length,
    episodes_created: episodesCreated,
    total: count,
    next_offset: hasMore ? offset + batchSize : null,
    errors,
  };
}

// ═══ PHASE 2: DID Conversations → Episodes ═══
async function bootstrapConversations(sb: any, userId: string, apiKey: string, batchSize: number, offset: number) {
  const { data: convs, count } = await sb
    .from("did_conversations")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (!convs || convs.length === 0) {
    return { phase: "conversations", status: "complete", processed: 0, total: count || 0, next_offset: null };
  }

  let episodesCreated = 0;
  const errors: string[] = [];

  for (const conv of convs) {
    try {
      // Check if already bootstrapped
      const { data: existing } = await sb
        .from("karel_episodes")
        .select("id")
        .eq("source_conversation_id", `did_conv:${conv.id}`)
        .eq("user_id", userId)
        .limit(1);
      if (existing && existing.length > 0) continue;

      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      if (msgs.length < 2) continue;

      const excerpt = msgs
        .filter((m: any) => typeof m === "object" && m.content)
        .slice(0, 12)
        .map((m: any) => `[${m.role}]: ${(m.content as string).slice(0, 300)}`)
        .join("\n");

      if (!excerpt.trim()) continue;

      const episode = await extractEpisodeFromText(
        apiKey,
        `DID konverzace "${conv.label}" (režim: ${conv.sub_mode}), datum: ${conv.saved_at}`,
        excerpt,
        "DID"
      );

      if (episode) {
        const { error } = await sb.from("karel_episodes").insert({
          user_id: userId,
          domain: "DID",
          hana_state: episode.hana_state || "EMO_KLIDNA",
          participants: episode.participants || [],
          summary_user: episode.summary_user || conv.label,
          summary_karel: episode.summary_karel || "",
          reasoning_notes: episode.reasoning_notes || "",
          emotional_intensity: Math.min(5, Math.max(1, episode.emotional_intensity || 3)),
          tags: [...(episode.tags || []), "bootstrap", conv.sub_mode],
          derived_facts: episode.derived_facts || [],
          actions_taken: episode.actions_taken || [],
          outcome: episode.outcome || "",
          timestamp_start: conv.created_at,
          timestamp_end: conv.saved_at,
          source_conversation_id: `did_conv:${conv.id}`,
          is_archived: true,
        });
        if (error) errors.push(`conv ${conv.id}: ${error.message}`);
        else episodesCreated++;
      }
    } catch (e) {
      errors.push(`conv ${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hasMore = (offset + batchSize) < (count || 0);

  await sb.from("karel_memory_logs").insert({
    user_id: userId,
    log_type: "bootstrap_conversations",
    summary: `Bootstrap DID convs batch ${offset}-${offset + convs.length}: ${episodesCreated} episodes`,
    episodes_created: episodesCreated,
    errors,
    details: { phase: "conversations", offset, batch_size: batchSize, total: count },
  });

  return {
    phase: "conversations",
    status: hasMore ? "in_progress" : "complete",
    processed: convs.length,
    episodes_created: episodesCreated,
    total: count,
    next_offset: hasMore ? offset + batchSize : null,
    errors,
  };
}

// ═══ PHASE 3: Hana Conversations → Episodes ═══
async function bootstrapHanaConversations(sb: any, userId: string, apiKey: string, batchSize: number, offset: number) {
  const { data: convs, count } = await sb
    .from("karel_hana_conversations")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (!convs || convs.length === 0) {
    return { phase: "hana", status: "complete", processed: 0, total: count || 0, next_offset: null };
  }

  let episodesCreated = 0;
  const errors: string[] = [];

  for (const conv of convs) {
    try {
      const { data: existing } = await sb
        .from("karel_episodes")
        .select("id")
        .eq("source_conversation_id", `hana_conv:${conv.id}`)
        .eq("user_id", userId)
        .limit(1);
      if (existing && existing.length > 0) continue;

      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      if (msgs.length < 2) continue;

      const excerpt = msgs
        .filter((m: any) => typeof m === "object" && m.content)
        .slice(0, 16)
        .map((m: any) => `[${m.role}]: ${(m.content as string).slice(0, 400)}`)
        .join("\n");

      if (!excerpt.trim()) continue;

      const episode = await extractEpisodeFromText(
        apiKey,
        `Konverzace Hana s Karlem, doména: ${conv.current_domain}, stav: ${conv.current_hana_state}, datum: ${conv.started_at}`,
        excerpt,
        conv.current_domain || "HANA"
      );

      if (episode) {
        const { error } = await sb.from("karel_episodes").insert({
          user_id: userId,
          domain: episode.domain || conv.current_domain || "HANA",
          hana_state: episode.hana_state || conv.current_hana_state || "EMO_KLIDNA",
          participants: episode.participants || ["hana"],
          summary_user: episode.summary_user || "Konverzace s Karlem",
          summary_karel: episode.summary_karel || "",
          reasoning_notes: episode.reasoning_notes || "",
          emotional_intensity: Math.min(5, Math.max(1, episode.emotional_intensity || 3)),
          tags: [...(episode.tags || []), "bootstrap", "hana_conv"],
          derived_facts: episode.derived_facts || [],
          actions_taken: episode.actions_taken || [],
          outcome: episode.outcome || "",
          timestamp_start: conv.started_at,
          timestamp_end: conv.last_activity_at,
          source_conversation_id: `hana_conv:${conv.id}`,
          is_archived: true,
        });
        if (error) errors.push(`hana ${conv.id}: ${error.message}`);
        else episodesCreated++;
      }
    } catch (e) {
      errors.push(`hana ${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const hasMore = (offset + batchSize) < (count || 0);

  await sb.from("karel_memory_logs").insert({
    user_id: userId,
    log_type: "bootstrap_hana",
    summary: `Bootstrap Hana convs batch ${offset}-${offset + convs.length}: ${episodesCreated} episodes`,
    episodes_created: episodesCreated,
    errors,
    details: { phase: "hana", offset, batch_size: batchSize, total: count },
  });

  return {
    phase: "hana",
    status: hasMore ? "in_progress" : "complete",
    processed: convs.length,
    episodes_created: episodesCreated,
    total: count,
    next_offset: hasMore ? offset + batchSize : null,
    errors,
  };
}

// ═══ PHASE 4: Consolidation pass over all bootstrap episodes ═══
async function runConsolidation(sb: any, userId: string, apiKey: string) {
  // Trigger the daily consolidation but for ALL archived bootstrap episodes
  const { data: episodes } = await sb
    .from("karel_episodes")
    .select("*")
    .eq("user_id", userId)
    .eq("is_archived", true)
    .containedBy("tags", ["bootstrap"])
    .order("timestamp_start", { ascending: true })
    .limit(50);

  // Actually just call the consolidation endpoint logic inline
  // But smarter: group episodes into batches of ~20 for AI
  const allEps = episodes || [];
  if (allEps.length === 0) {
    // Try getting ALL bootstrap episodes with a different query
    const { data: allBootstrap } = await sb
      .from("karel_episodes")
      .select("id, domain, hana_state, summary_karel, summary_user, tags, derived_facts, emotional_intensity, participants, timestamp_start")
      .eq("user_id", userId)
      .order("timestamp_start", { ascending: true })
      .limit(200);

    if (!allBootstrap || allBootstrap.length === 0) {
      return { phase: "consolidate", status: "no_episodes" };
    }

    // Build mega-summary for semantic extraction
    const megaSummary = allBootstrap.map((ep: any) =>
      `[${ep.domain}/${ep.hana_state}] ${ep.summary_karel || ep.summary_user} | tags: ${(ep.tags || []).join(",")} | facts: ${(ep.derived_facts || []).join("; ")} | participants: ${(ep.participants || []).join(",")}`
    ).join("\n");

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi analytický modul. Extrahuj sémantická data z historických epizod terapeutického agenta." },
          { role: "user", content: buildConsolidationPrompt(megaSummary, allBootstrap.length) },
        ],
        tools: [consolidationTool()],
        tool_choice: { type: "function", function: { name: "bootstrap_semantic_memory" } },
      }),
    });

    if (!aiRes.ok) throw new Error(`AI failed: ${aiRes.status}`);

    const aiData = await aiRes.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("No tool call in consolidation response");

    const result = JSON.parse(toolCall.function.arguments);
    const stats = await applySemanticData(sb, userId, result, allBootstrap.map((e: any) => e.id));

    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "bootstrap_consolidation",
      summary: result.summary || `Bootstrap konsolidace: ${stats.entities} entit, ${stats.patterns} vzorců, ${stats.strategies} strategií`,
      episodes_created: 0,
      semantic_updates: stats.entities + stats.patterns + stats.relations,
      strategy_updates: stats.strategies,
      details: stats,
    });

    return { phase: "consolidate", status: "complete", ...stats, summary: result.summary };
  }

  return { phase: "consolidate", status: "no_data" };
}

// ═══ SHARED: Extract episode from conversation text ═══
async function extractEpisodeFromText(apiKey: string, context: string, excerpt: string, defaultDomain: string) {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: "Extrahuj strukturovanou epizodu z konverzace. Odpověz POUZE validním JSON." },
        { role: "user", content: `Kontext: ${context}\n\nKonverzace:\n${excerpt}\n\nExtrahuj epizodu jako JSON s poli: domain (HANA|DID|PRACE), hana_state (EMO_KLIDNA|EMO_PRETIZENA|EMO_ROZCILENA|EMO_ANALYTICKA|EMO_DISOCIACE|EMO_RADOSTNA|EMO_SMUTNA|EMO_UZKOSTNA), participants (string[]), summary_user (1 věta), summary_karel (2-3 věty z pohledu terapeuta), reasoning_notes (string), emotional_intensity (1-10), tags (string[]), derived_facts (string[]), actions_taken (string[]), outcome (string).` },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    console.error(`[bootstrap] AI extract failed: ${res.status}`);
    return null;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch {
    console.error("[bootstrap] Failed to parse episode JSON");
    return null;
  }
}

// ═══ Consolidation prompt & tool ═══
function buildConsolidationPrompt(megaSummary: string, count: number) {
  return `Analyzuj ${count} historických epizod a extrahuj:
1. ENTITY – osoby, části DID, místa, témata, organizace
2. VZORCE – opakující se emoční/behaviorální/komunikační vzorce
3. VZTAHY – mezi entitami
4. STRATEGIE – co fungovalo/nefungovalo při interakci

Epizody:
${megaSummary}

Pravidla:
- ID: snake_case, max 40 znaků
- Confidence 0.0-1.0 (vyšší = více evidencí)
- Buď konkrétní a stručný`;
}

function consolidationTool() {
  return {
    type: "function",
    function: {
      name: "bootstrap_semantic_memory",
      description: "Bootstrap sémantické paměti z historických epizod",
      parameters: {
        type: "object",
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                jmeno: { type: "string" },
                typ: { type: "string", enum: ["clovek", "cast", "cast_did", "misto", "tema", "organizace", "klient", "rodina", "jiny"] },
                role_vuci_hance: { type: "string" },
                stabilni_vlastnosti: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
              },
              required: ["id", "jmeno", "typ"],
            },
          },
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                domain: { type: "string", enum: ["HANA", "DID", "PRACE", "OBECNE"] },
                confidence: { type: "number" },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["id", "description", "domain", "confidence"],
            },
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                subject_id: { type: "string" },
                relation: { type: "string" },
                object_id: { type: "string" },
                description: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["subject_id", "relation", "object_id"],
            },
          },
          strategies: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                domain: { type: "string", enum: ["HANA", "DID", "PRACE", "OBECNE"] },
                hana_state: { type: "string" },
                guidelines: { type: "array", items: { type: "string" } },
                example_phrases: { type: "array", items: { type: "string" } },
                effectiveness_score: { type: "number" },
              },
              required: ["id", "description"],
            },
          },
          summary: { type: "string" },
        },
        required: ["entities", "patterns", "relations", "strategies", "summary"],
      },
    },
  };
}

// ═══ Apply semantic data to DB ═══
async function applySemanticData(sb: any, userId: string, data: any, episodeIds: string[]) {
  let entities = 0, patterns = 0, relations = 0, strategies = 0;
  const errors: string[] = [];

  // Entities
  for (const ent of (data.entities || [])) {
    const { error } = await sb.from("karel_semantic_entities").upsert({
      id: ent.id,
      user_id: userId,
      jmeno: ent.jmeno,
      typ: ent.typ || "jiny",
      role_vuci_hance: ent.role_vuci_hance || "",
      stabilni_vlastnosti: ent.stabilni_vlastnosti || [],
      notes: ent.notes || "",
      evidence_episodes: episodeIds.slice(0, 20),
    }, { onConflict: "id" });
    if (error) errors.push(`entity ${ent.id}: ${error.message}`);
    else entities++;
  }

  // Patterns
  for (const pat of (data.patterns || [])) {
    const { error } = await sb.from("karel_semantic_patterns").upsert({
      id: pat.id,
      user_id: userId,
      description: pat.description,
      domain: pat.domain || "HANA",
      confidence: pat.confidence || 0.5,
      tags: pat.tags || [],
      evidence_episodes: episodeIds.slice(0, 20),
    }, { onConflict: "id" });
    if (error) errors.push(`pattern ${pat.id}: ${error.message}`);
    else patterns++;
  }

  // Relations
  for (const rel of (data.relations || [])) {
    const { error } = await sb.from("karel_semantic_relations").insert({
      user_id: userId,
      subject_id: rel.subject_id,
      relation: rel.relation,
      object_id: rel.object_id,
      description: rel.description || "",
      confidence: rel.confidence || 0.5,
      evidence_episodes: episodeIds.slice(0, 10),
    });
    if (error) errors.push(`relation: ${error.message}`);
    else relations++;
  }

  // Strategies
  for (const strat of (data.strategies || [])) {
    const { error } = await sb.from("karel_strategies").upsert({
      id: strat.id,
      user_id: userId,
      description: strat.description,
      domain: strat.domain || "HANA",
      hana_state: strat.hana_state || "",
      guidelines: strat.guidelines || [],
      example_phrases: strat.example_phrases || [],
      effectiveness_score: strat.effectiveness_score || 0.5,
      evidence_episodes: episodeIds.slice(0, 10),
    }, { onConflict: "id" });
    if (error) errors.push(`strategy ${strat.id}: ${error.message}`);
    else strategies++;
  }

  return { entities, patterns, relations, strategies, errors };
}
