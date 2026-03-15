import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Daily Consolidation – Fáze 4
 * 
 * Spouštěno externím cronem (cron-job.org) denně v 6:00 CET
 * nebo manuálně tlačítkem "Osvěž paměť" z frontendu.
 * 
 * Kroky:
 * 1. Načte nezpracované epizody (posledních 24h)
 * 2. AI analyzuje: nové entity, vztahy, vzorce, strategie
 * 3. Upsert do sémantických tabulek
 * 4. Označí epizody jako zpracované
 * 5. Zapíše log
 */

function isCronOrManual(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") || "";
  const ua = req.headers.get("User-Agent") || "";
  // Service role key = cron/internal
  if (authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__")) return true;
  // pg_net internal calls
  if (ua.startsWith("pg_net/") || ua.startsWith("Supabase Edge Functions")) return true;
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth: either cron (service role) or authenticated user
  let userId: string;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (isCronOrManual(req)) {
    // For cron: process all users or take userId from body
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body ok */ }
    
    if (body.source === "cron") {
      // Get all distinct user_ids with recent episodes
      const { data: users } = await sb
        .from("karel_episodes")
        .select("user_id")
        .gte("created_at", new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString());
      
      const uniqueUsers = [...new Set((users || []).map((u: any) => u.user_id))];
      console.log(`[consolidation] Cron trigger: ${uniqueUsers.length} users with recent episodes`);
      
      const results = [];
      for (const uid of uniqueUsers) {
        try {
          const result = await consolidateForUser(sb, uid as string, LOVABLE_API_KEY);
          results.push({ user_id: uid, ...result });
        } catch (e) {
          results.push({ user_id: uid, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Before consolidation, trigger DID episode generation for unprocessed threads
      let didEpisodeResult: any = null;
      try {
        const didEpUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-did-episode-generate`;
        const didEpRes = await fetch(didEpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ crossModeScan: true, source: "consolidation" }),
        });
        didEpisodeResult = await didEpRes.json();
        console.log(`[consolidation] DID episode generation:`, didEpisodeResult.status || didEpisodeResult);
      } catch (e) {
        console.error("[consolidation] DID episode generation failed:", e);
        didEpisodeResult = { error: e instanceof Error ? e.message : String(e) };
      }

      // After consolidation, trigger memory mirror to Drive
      let mirrorResult: any = null;
      try {
        const mirrorUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-memory-mirror`;
        const mirrorRes = await fetch(mirrorUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
        });
        mirrorResult = await mirrorRes.json();
        console.log(`[consolidation] Mirror result:`, mirrorResult.status || mirrorResult.error);
      } catch (mirrorErr) {
        console.error("[consolidation] Mirror failed:", mirrorErr);
        mirrorResult = { error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr) };
      }
      
      return new Response(JSON.stringify({ results, mirror: mirrorResult, didEpisodes: didEpisodeResult }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    userId = body.userId || body.user_id || "";
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required for manual trigger" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    // Authenticated user
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = user.id;
  }

  try {
    const result = await consolidateForUser(sb, userId, LOVABLE_API_KEY);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[consolidation] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function consolidateForUser(sb: any, userId: string, apiKey: string) {
  const startTime = Date.now();
  
  // 1. Load recent unarchived episodes
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  
  const [episodesRes, entitiesRes, patternsRes, relationsRes, strategiesRes] = await Promise.all([
    sb.from("karel_episodes")
      .select("*")
      .eq("user_id", userId)
      .eq("is_archived", false)
      .gte("created_at", twentyFourHoursAgo)
      .order("created_at", { ascending: true }),
    sb.from("karel_semantic_entities")
      .select("*")
      .eq("user_id", userId),
    sb.from("karel_semantic_patterns")
      .select("*")
      .eq("user_id", userId),
    sb.from("karel_semantic_relations")
      .select("*")
      .eq("user_id", userId),
    sb.from("karel_strategies")
      .select("*")
      .eq("user_id", userId),
  ]);

  const episodes = episodesRes.data || [];
  const existingEntities = entitiesRes.data || [];
  const existingPatterns = patternsRes.data || [];
  const existingRelations = relationsRes.data || [];
  const existingStrategies = strategiesRes.data || [];

  console.log(`[consolidation] User ${userId}: ${episodes.length} episodes, ${existingEntities.length} entities, ${existingPatterns.length} patterns, ${existingStrategies.length} strategies`);

  if (episodes.length === 0) {
    // Log empty run
    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "daily_consolidation",
      summary: "Žádné nové epizody k konsolidaci.",
      episodes_created: 0,
      semantic_updates: 0,
      strategy_updates: 0,
    });
    return { status: "no_episodes", episodes_processed: 0 };
  }

  // 2. Build context for AI
  const episodeSummaries = episodes.map((ep: any) => 
    `[${ep.domain}/${ep.hana_state}] ${ep.summary_karel || ep.summary_user} | tags: ${(ep.tags || []).join(",")} | facts: ${(ep.derived_facts || []).join("; ")} | intensity: ${ep.emotional_intensity}`
  ).join("\n");

  const entityList = existingEntities.map((e: any) => 
    `${e.id}: ${e.jmeno} (${e.typ}) – ${e.role_vuci_hance} [${(e.stabilni_vlastnosti || []).join(", ")}]`
  ).join("\n");

  const patternList = existingPatterns.map((p: any) => 
    `${p.id}: ${p.description} (conf: ${p.confidence}, domain: ${p.domain})`
  ).join("\n");

  const strategyList = existingStrategies.map((s: any) => 
    `${s.id}: ${s.description} (domain: ${s.domain}, state: ${s.hana_state}, eff: ${s.effectiveness_score})`
  ).join("\n");

  const prompt = `Jsi Karel – kognitivní agent pro terapeutickou podporu. Proveď DENNÍ KONSOLIDACI paměti.

═══ DNEŠNÍ EPIZODY (${episodes.length}) ═══
${episodeSummaries}

═══ EXISTUJÍCÍ ENTITY (${existingEntities.length}) ═══
${entityList || "(prázdné)"}

═══ EXISTUJÍCÍ VZORCE (${existingPatterns.length}) ═══
${patternList || "(prázdné)"}

═══ EXISTUJÍCÍ STRATEGIE (${existingStrategies.length}) ═══
${strategyList || "(prázdné)"}

INSTRUKCE:
1. Analyzuj dnešní epizody a porovnej s existující pamětí
2. Identifikuj NOVÉ entity (osoby, místa, témata) – přidej je
3. Identifikuj NOVÉ nebo POSÍLENÉ vzorce (opakující se emoce, chování, témata)
4. Navrhni ÚPRAVY strategií (co funguje lépe/hůře, nové přístupy)
5. Identifikuj NOVÉ vztahy mezi entitami

PRAVIDLA:
- ID entit/vzorců/strategií: snake_case, max 40 znaků
- Nemazej existující – pouze přidávej nebo aktualizuj
- Confidence 0.0-1.0: nový vzorec začíná na 0.3, posiluj při opakování
- U strategií: effectiveness_score 0.0-1.0

Odpověz STRIKTNĚ jako JSON (tool call).`;

  // 3. AI analysis with tool calling for structured output
  const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Jsi analytický modul kognitivního agenta. Extrahuj strukturovaná data z epizod." },
        { role: "user", content: prompt },
      ],
      tools: [{
        type: "function",
        function: {
          name: "consolidate_memory",
          description: "Konsoliduj denní paměť – entity, vzorce, vztahy, strategie",
          parameters: {
            type: "object",
            properties: {
              new_entities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    jmeno: { type: "string" },
                    typ: { type: "string", enum: ["clovek", "misto", "tema", "organizace", "cast_did"] },
                    role_vuci_hance: { type: "string" },
                    stabilni_vlastnosti: { type: "array", items: { type: "string" } },
                    notes: { type: "string" },
                  },
                  required: ["id", "jmeno", "typ", "role_vuci_hance"],
                },
              },
              updated_entities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    notes: { type: "string" },
                    new_properties: { type: "array", items: { type: "string" } },
                  },
                  required: ["id"],
                },
              },
              new_patterns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    domain: { type: "string" },
                    confidence: { type: "number" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["id", "description", "domain", "confidence"],
                },
              },
              reinforced_patterns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    confidence_delta: { type: "number" },
                    note: { type: "string" },
                  },
                  required: ["id", "confidence_delta"],
                },
              },
              new_relations: {
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
              strategy_updates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    domain: { type: "string" },
                    hana_state: { type: "string" },
                    effectiveness_delta: { type: "number" },
                    new_guidelines: { type: "array", items: { type: "string" } },
                    new_phrases: { type: "array", items: { type: "string" } },
                  },
                  required: ["id", "description"],
                },
              },
              summary: { type: "string" },
            },
            required: ["summary"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "consolidate_memory" } },
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error("[consolidation] AI error:", aiRes.status, errText);
    throw new Error(`AI consolidation failed: ${aiRes.status}`);
  }

  const aiData = await aiRes.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("No tool call in AI response");

  let result: any;
  try {
    result = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error("Failed to parse AI consolidation output");
  }

  console.log(`[consolidation] AI result: ${(result.new_entities || []).length} new entities, ${(result.new_patterns || []).length} new patterns, ${(result.strategy_updates || []).length} strategy updates`);

  // 4. Apply changes to DB
  let semanticUpdates = 0;
  let strategyUpdates = 0;
  const errors: string[] = [];
  const episodeIds = episodes.map((ep: any) => ep.id);

  // 4a. New entities
  for (const ent of (result.new_entities || [])) {
    // Skip if already exists
    if (existingEntities.some((e: any) => e.id === ent.id)) continue;
    const { error } = await sb.from("karel_semantic_entities").insert({
      id: ent.id,
      user_id: userId,
      jmeno: ent.jmeno,
      typ: ent.typ || "clovek",
      role_vuci_hance: ent.role_vuci_hance || "",
      stabilni_vlastnosti: ent.stabilni_vlastnosti || [],
      notes: ent.notes || "",
      evidence_episodes: episodeIds,
    });
    if (error) { errors.push(`entity ${ent.id}: ${error.message}`); } else { semanticUpdates++; }
  }

  // 4b. Updated entities
  for (const upd of (result.updated_entities || [])) {
    const existing = existingEntities.find((e: any) => e.id === upd.id);
    if (!existing) continue;
    const updateData: any = { updated_at: new Date().toISOString() };
    if (upd.notes) updateData.notes = existing.notes ? `${existing.notes}\n${upd.notes}` : upd.notes;
    if (upd.new_properties?.length) {
      updateData.stabilni_vlastnosti = [...new Set([...(existing.stabilni_vlastnosti || []), ...upd.new_properties])];
    }
    updateData.evidence_episodes = [...new Set([...(existing.evidence_episodes || []), ...episodeIds])];
    const { error } = await sb.from("karel_semantic_entities").update(updateData).eq("id", upd.id).eq("user_id", userId);
    if (error) { errors.push(`entity update ${upd.id}: ${error.message}`); } else { semanticUpdates++; }
  }

  // 4c. New patterns
  for (const pat of (result.new_patterns || [])) {
    if (existingPatterns.some((p: any) => p.id === pat.id)) continue;
    const { error } = await sb.from("karel_semantic_patterns").insert({
      id: pat.id,
      user_id: userId,
      description: pat.description,
      domain: pat.domain || "HANA",
      confidence: pat.confidence || 0.3,
      tags: pat.tags || [],
      evidence_episodes: episodeIds,
    });
    if (error) { errors.push(`pattern ${pat.id}: ${error.message}`); } else { semanticUpdates++; }
  }

  // 4d. Reinforced patterns
  for (const rp of (result.reinforced_patterns || [])) {
    const existing = existingPatterns.find((p: any) => p.id === rp.id);
    if (!existing) continue;
    const newConfidence = Math.min(1, Math.max(0, (existing.confidence || 0.5) + (rp.confidence_delta || 0.05)));
    const { error } = await sb.from("karel_semantic_patterns").update({
      confidence: newConfidence,
      evidence_episodes: [...new Set([...(existing.evidence_episodes || []), ...episodeIds])],
      updated_at: new Date().toISOString(),
    }).eq("id", rp.id).eq("user_id", userId);
    if (error) { errors.push(`pattern reinforce ${rp.id}: ${error.message}`); } else { semanticUpdates++; }
  }

  // 4e. New relations
  for (const rel of (result.new_relations || [])) {
    // Check duplicate
    const exists = existingRelations.some((r: any) => 
      r.subject_id === rel.subject_id && r.relation === rel.relation && r.object_id === rel.object_id
    );
    if (exists) continue;
    const { error } = await sb.from("karel_semantic_relations").insert({
      user_id: userId,
      subject_id: rel.subject_id,
      relation: rel.relation,
      object_id: rel.object_id,
      description: rel.description || "",
      confidence: rel.confidence || 0.5,
      evidence_episodes: episodeIds,
    });
    if (error) { errors.push(`relation: ${error.message}`); } else { semanticUpdates++; }
  }

  // 4f. Strategy updates (upsert)
  for (const strat of (result.strategy_updates || [])) {
    const existing = existingStrategies.find((s: any) => s.id === strat.id);
    if (existing) {
      const newEff = Math.min(1, Math.max(0, (existing.effectiveness_score || 0.5) + (strat.effectiveness_delta || 0)));
      const updateData: any = {
        effectiveness_score: newEff,
        evidence_episodes: [...new Set([...(existing.evidence_episodes || []), ...episodeIds])],
        updated_at: new Date().toISOString(),
      };
      if (strat.new_guidelines?.length) {
        updateData.guidelines = [...new Set([...(existing.guidelines || []), ...strat.new_guidelines])];
      }
      if (strat.new_phrases?.length) {
        updateData.example_phrases = [...new Set([...(existing.example_phrases || []), ...strat.new_phrases])];
      }
      const { error } = await sb.from("karel_strategies").update(updateData).eq("id", strat.id).eq("user_id", userId);
      if (error) { errors.push(`strategy update ${strat.id}: ${error.message}`); } else { strategyUpdates++; }
    } else {
      // New strategy
      const { error } = await sb.from("karel_strategies").insert({
        id: strat.id,
        user_id: userId,
        description: strat.description,
        domain: strat.domain || "HANA",
        hana_state: strat.hana_state || "",
        guidelines: strat.new_guidelines || [],
        example_phrases: strat.new_phrases || [],
        effectiveness_score: 0.5,
        evidence_episodes: episodeIds,
      });
      if (error) { errors.push(`strategy new ${strat.id}: ${error.message}`); } else { strategyUpdates++; }
    }
  }

  // 5. Archive processed episodes
  await sb.from("karel_episodes")
    .update({ is_archived: true })
    .eq("user_id", userId)
    .in("id", episodeIds);

  // 6. Write log
  const elapsed = Date.now() - startTime;
  await sb.from("karel_memory_logs").insert({
    user_id: userId,
    log_type: "daily_consolidation",
    summary: result.summary || `Konsolidováno ${episodes.length} epizod.`,
    episodes_created: episodes.length,
    semantic_updates: semanticUpdates,
    strategy_updates: strategyUpdates,
    errors: errors,
    details: {
      elapsed_ms: elapsed,
      new_entities: (result.new_entities || []).length,
      updated_entities: (result.updated_entities || []).length,
      new_patterns: (result.new_patterns || []).length,
      reinforced_patterns: (result.reinforced_patterns || []).length,
      new_relations: (result.new_relations || []).length,
      strategy_updates: (result.strategy_updates || []).length,
    },
  });

  console.log(`[consolidation] Done for ${userId}: ${semanticUpdates} semantic, ${strategyUpdates} strategy updates in ${elapsed}ms. Errors: ${errors.length}`);

  return {
    status: "completed",
    episodes_processed: episodes.length,
    semantic_updates: semanticUpdates,
    strategy_updates: strategyUpdates,
    errors,
    summary: result.summary,
  };
}
