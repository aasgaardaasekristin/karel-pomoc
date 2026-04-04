import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

/**
 * Karel DID Episode Generator
 * 
 * Generates structured episodes from DID threads after:
 * - Thread end (handleDidEndCall)
 * - Thread leave (handleLeaveThread)  
 * - 30min inactivity (future cron)
 * 
 * Also performs cross-mode scanning of karel_hana_conversations for DID mentions.
 * 
 * Input: { threadId?, crossModeScan?: boolean }
 * Output: { episodes_created, cross_mode_episodes }
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Auth: service role (cron/internal) or authenticated user
  let userId: string;
  const authHeader = req.headers.get("Authorization") || "";
  const ua = req.headers.get("User-Agent") || "";
  const isCron = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__") ||
    ua.startsWith("pg_net/") || ua.startsWith("Supabase Edge Functions");

  let body: any = {};
  try { body = await req.json(); } catch {}

  if (isCron) {
    userId = body.userId || body.user_id || "";
    if (!userId) {
      // Process all users with recent DID threads
      const { data: users } = await sb
        .from("did_threads")
        .select("user_id")
        .eq("is_processed", false)
        .gte("last_activity_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
      
      const uniqueUsers = [...new Set((users || []).map((u: any) => u.user_id))];
      const results = [];
      for (const uid of uniqueUsers) {
        try {
          const result = await processForUser(sb, uid as string, LOVABLE_API_KEY, body);
          results.push({ user_id: uid, ...result });
        } catch (e) {
          results.push({ user_id: uid, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
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
    const result = await processForUser(sb, userId, LOVABLE_API_KEY, body);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[did-episode-generate] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function processForUser(sb: any, userId: string, apiKey: string, body: any) {
  const { threadId, crossModeScan } = body;
  let episodesCreated = 0;
  let crossModeEpisodes = 0;
  const errors: string[] = [];

  // ═══ STEP 1: Generate episodes from specific thread or all unprocessed threads ═══
  let threads: any[] = [];
  
  if (threadId) {
    const { data } = await sb.from("did_threads")
      .select("*")
      .eq("id", threadId)
      .eq("user_id", userId)
      .single();
    if (data) threads = [data];
  } else {
    // Get all unprocessed threads with >= 2 messages
    const { data } = await sb.from("did_threads")
      .select("*")
      .eq("user_id", userId)
      .eq("is_processed", false)
      .order("last_activity_at", { ascending: false })
      .limit(20);
    threads = (data || []).filter((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      return msgs.filter((m: any) => m.role === "user").length >= 1;
    });
  }

  console.log(`[did-episode-generate] User ${userId}: ${threads.length} threads to process`);

  for (const thread of threads) {
    try {
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      if (msgs.length < 2) continue;

      const conversationText = msgs.map((m: any) => 
        `${m.role === "user" ? "UŽIVATEL" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 500) : "[media]"}`
      ).join("\n");

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: SYSTEM_RULES + `\n\nJsi analytický modul kognitivního agenta Karla. Extrahuj strukturovanou epizodu z DID konverzace.

KONTEXT: Toto je rozhovor z DID režimu (disociativní porucha identity u dětí).
- part_name: "${thread.part_name}" (jméno aktivní části/fragmentu)
- sub_mode: "${thread.sub_mode}" (cast=přímý rozhovor s částí, mamka=s Hankou, kata=s Káťou)
- started_at: ${thread.started_at}

INSTRUKCE:
- Shrň CO se stalo (summary_user), CO Karel pozoroval (summary_karel)
- Identifikuj emocionální stav části/terapeutky (hana_state)
- Urči domain (vždy "DID")
- Vypiš participants (jména aktivních částí + terapeutky)
- Identifikuj odvozené fakty (derived_facts) a tagy
- Ohodnoť emocionální intenzitu (1-5)
- Identifikuj akce provedené Karlem (actions_taken)
- NIKDY nevymýšlej – pouze extrahuj z konverzace` },
            { role: "user", content: `Konverzace:\n${conversationText.slice(0, 8000)}` },
          ],
          tools: [{
            type: "function",
            function: {
              name: "create_did_episode",
              description: "Vytvoř strukturovanou DID epizodu z konverzace",
              parameters: {
                type: "object",
                properties: {
                  summary_user: { type: "string", description: "Shrnutí z pohledu uživatele/části (2-3 věty)" },
                  summary_karel: { type: "string", description: "Karlovo profesionální shrnutí - co pozoroval, jaké techniky použil (2-3 věty)" },
                  hana_state: { type: "string", enum: ["EMO_KLIDNA", "EMO_SMUTNA", "EMO_NASTVANA", "EMO_UZKOSTNA", "EMO_RADOSTNA", "EMO_UNAVENA", "EMO_ZMATENOST", "KRIZE", "STABILNI"] },
                  emotional_intensity: { type: "number", minimum: 1, maximum: 5 },
                  participants: { type: "array", items: { type: "string" }, description: "Jména všech zúčastněných (části + terapeutky)" },
                  derived_facts: { type: "array", items: { type: "string" }, description: "Nově zjištěné fakty o systému" },
                  actions_taken: { type: "array", items: { type: "string" }, description: "Co Karel udělal (techniky, doporučení)" },
                  tags: { type: "array", items: { type: "string" }, description: "Tagy formátu: part:Arthur, submode:cast, therapist:Hanka, topic:regulace, technique:grounding atd." },
                  outcome: { type: "string", description: "Výsledek sezení (1 věta)" },
                  reasoning_notes: { type: "string", description: "Karlovy interní poznámky pro budoucí referenci" },
                },
                required: ["summary_user", "summary_karel", "hana_state", "emotional_intensity", "participants", "tags", "outcome"],
              },
            },
          }],
          tool_choice: { type: "function", function: { name: "create_did_episode" } },
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error(`[did-episode-generate] AI error for thread ${thread.id}:`, aiRes.status, errText);
        errors.push(`thread ${thread.id}: AI ${aiRes.status}`);
        continue;
      }

      const aiData = await aiRes.json();
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        errors.push(`thread ${thread.id}: no tool call`);
        continue;
      }

      let episode: any;
      try {
        episode = JSON.parse(toolCall.function.arguments);
      } catch {
        errors.push(`thread ${thread.id}: parse error`);
        continue;
      }

      // Ensure DID-specific tags
      const tags = episode.tags || [];
      if (!tags.some((t: string) => t.startsWith("part:"))) {
        tags.push(`part:${thread.part_name}`);
      }
      if (!tags.some((t: string) => t.startsWith("submode:"))) {
        tags.push(`submode:${thread.sub_mode}`);
      }

      // Insert episode
      const { error: insertError } = await sb.from("karel_episodes").insert({
        user_id: userId,
        domain: "DID",
        hana_state: episode.hana_state || "STABILNI",
        emotional_intensity: episode.emotional_intensity || 3,
        summary_user: episode.summary_user || "",
        summary_karel: episode.summary_karel || "",
        participants: episode.participants || [thread.part_name],
        derived_facts: episode.derived_facts || [],
        actions_taken: episode.actions_taken || [],
        tags,
        outcome: episode.outcome || "",
        reasoning_notes: episode.reasoning_notes || "",
        source_conversation_id: thread.id,
        timestamp_start: thread.started_at,
        timestamp_end: thread.last_activity_at,
      });

      if (insertError) {
        errors.push(`thread ${thread.id}: insert ${insertError.message}`);
      } else {
        episodesCreated++;
        // Mark thread as processed
        await sb.from("did_threads")
          .update({ is_processed: true, processed_at: new Date().toISOString() })
          .eq("id", thread.id);
        
        // Auto-populate did_part_registry
        try {
          await sb.from("did_part_registry").upsert({
            user_id: userId,
            part_name: thread.part_name.toLowerCase(),
            display_name: thread.part_name,
            status: "active",
            language: thread.part_language || "cs",
            last_seen_at: thread.last_activity_at,
            last_emotional_state: episode.hana_state || "STABILNI",
            last_emotional_intensity: episode.emotional_intensity || 3,
            total_threads: 1,
            total_episodes: 1,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id,part_name" });
          
          // Increment counters for existing parts
          const { data: existing } = await sb.from("did_part_registry")
            .select("total_threads, total_episodes")
            .eq("user_id", userId)
            .eq("part_name", thread.part_name.toLowerCase())
            .single();
          if (existing) {
            await sb.from("did_part_registry").update({
              total_threads: (existing.total_threads || 0) + 1,
              total_episodes: (existing.total_episodes || 0) + 1,
              last_seen_at: thread.last_activity_at,
              last_emotional_state: episode.hana_state || "STABILNI",
              last_emotional_intensity: episode.emotional_intensity || 3,
              status: "active",
              updated_at: new Date().toISOString(),
            }).eq("user_id", userId).eq("part_name", thread.part_name.toLowerCase());
          }
        } catch (regErr) {
          console.warn(`[did-episode-generate] Registry upsert error for ${thread.part_name}:`, regErr);
        }
      }
    } catch (e) {
      errors.push(`thread ${thread.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ═══ STEP 2: Cross-mode scanning — find DID mentions in Hana conversations ═══
  if (crossModeScan !== false) {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      // Get recent Hana conversations not yet scanned for DID
      const { data: hanaConvs } = await sb
        .from("karel_hana_conversations")
        .select("id, messages, last_activity_at, current_domain, current_hana_state")
        .eq("user_id", userId)
        .gte("last_activity_at", twentyFourHoursAgo)
        .order("last_activity_at", { ascending: false })
        .limit(10);

      // Check which we already have episodes for
      const { data: existingSourceIds } = await sb
        .from("karel_episodes")
        .select("source_conversation_id")
        .eq("user_id", userId)
        .eq("domain", "DID")
        .in("source_conversation_id", (hanaConvs || []).map((c: any) => `hana_${c.id}`));

      const processedIds = new Set((existingSourceIds || []).map((e: any) => e.source_conversation_id));

      for (const conv of (hanaConvs || [])) {
        if (processedIds.has(`hana_${conv.id}`)) continue;

        const msgs = Array.isArray(conv.messages) ? conv.messages : [];
        const fullText = msgs.map((m: any) => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();

        // Check for DID-related keywords
        const didKeywords = [
          "did", "disociativní", "disociace", "část", "fragment", "alter", "switcher",
          "arthur", "lincoln", "přepnutí", "systém", "vnitřní", "kartotéka",
          "mamka", "terapeutka", "hanka", "káťa", "kluci", "děti",
          // Known part names could be dynamically loaded, but for now use common ones
        ];

        const hasDIDMention = didKeywords.some(kw => fullText.includes(kw));
        if (!hasDIDMention) continue;

        // Only process conversations with meaningful content
        const userMsgs = msgs.filter((m: any) => m.role === "user");
        if (userMsgs.length < 1) continue;

        const conversationText = msgs.slice(-20).map((m: any) =>
          `${m.role === "user" ? "HANA" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 300) : "[media]"}`
        ).join("\n");

        try {
          const classifyRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: SYSTEM_RULES + `\n\nAnalyzuj konverzaci Hanky s Karlem. Obsahuje KLINICKY RELEVANTNÍ informace o DID systému (částech, fragmentech, terapeutické práci s nimi)?
Odpověz POUZE "YES" nebo "NO". YES = zmíněna konkrétní informace o stavu/chování/vývoji nějaké části, která by měla být zaznamenána.` },
                { role: "user", content: conversationText.slice(0, 4000) },
              ],
            }),
          });

          if (!classifyRes.ok) continue;
          const classifyData = await classifyRes.json();
          const answer = (classifyData.choices?.[0]?.message?.content || "").trim().toUpperCase();
          
          if (!answer.includes("YES")) continue;

          // Generate cross-mode episode
          const episodeRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: SYSTEM_RULES + `\n\nExtrahuj DID-relevantní informace z konverzace Hanky s Karlem (osobní režim). Zaměř se POUZE na zmínky o částech/fragmentech DID systému, jejich stavu, chování, pokrocích. Ignoruj osobní témata Hanky nesouvisející s DID.` },
                { role: "user", content: conversationText.slice(0, 6000) },
              ],
              tools: [{
                type: "function",
                function: {
                  name: "create_did_episode",
                  description: "Vytvoř cross-mode DID epizodu",
                  parameters: {
                    type: "object",
                    properties: {
                      summary_user: { type: "string" },
                      summary_karel: { type: "string" },
                      hana_state: { type: "string", enum: ["EMO_KLIDNA", "EMO_SMUTNA", "EMO_NASTVANA", "EMO_UZKOSTNA", "EMO_RADOSTNA", "EMO_UNAVENA", "STABILNI"] },
                      emotional_intensity: { type: "number", minimum: 1, maximum: 5 },
                      participants: { type: "array", items: { type: "string" } },
                      derived_facts: { type: "array", items: { type: "string" } },
                      tags: { type: "array", items: { type: "string" } },
                      outcome: { type: "string" },
                    },
                    required: ["summary_user", "summary_karel", "participants", "tags"],
                  },
                },
              }],
              tool_choice: { type: "function", function: { name: "create_did_episode" } },
            }),
          });

          if (!episodeRes.ok) continue;
          const episodeData = await episodeRes.json();
          const tc = episodeData.choices?.[0]?.message?.tool_calls?.[0];
          if (!tc) continue;

          let ep: any;
          try { ep = JSON.parse(tc.function.arguments); } catch { continue; }

          const crossTags = [...(ep.tags || []), "source:cross_mode", "source:hana_conversation"];

          const { error: insertErr } = await sb.from("karel_episodes").insert({
            user_id: userId,
            domain: "DID",
            hana_state: ep.hana_state || conv.current_hana_state || "STABILNI",
            emotional_intensity: ep.emotional_intensity || 2,
            summary_user: ep.summary_user || "",
            summary_karel: ep.summary_karel || "",
            participants: ep.participants || ["Hanka"],
            derived_facts: ep.derived_facts || [],
            actions_taken: [],
            tags: crossTags,
            outcome: ep.outcome || "",
            reasoning_notes: "Cross-mode episode: DID zmínka v osobním režimu Hany",
            source_conversation_id: `hana_${conv.id}`,
            timestamp_start: conv.last_activity_at,
          });

          if (!insertErr) crossModeEpisodes++;
        } catch (e) {
          console.warn(`[did-episode-generate] Cross-mode error for conv ${conv.id}:`, e);
        }
      }
    } catch (e) {
      errors.push(`cross-mode: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[did-episode-generate] Done for ${userId}: ${episodesCreated} thread episodes, ${crossModeEpisodes} cross-mode episodes. Errors: ${errors.length}`);

  return {
    status: "completed",
    episodes_created: episodesCreated,
    cross_mode_episodes: crossModeEpisodes,
    errors,
  };
}
